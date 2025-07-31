const path = require('path');
const { IncomingForm } = require('formidable');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const { MongoClient, ObjectId } = require('mongodb');
const fs = require('fs/promises');

// --- Cloudinary Configuration ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_SECRET_KEY,
  secure: true
});

// --- MongoDB Configuration ---
console.log('DEBUG: MONGODB_URI from environment:', process.env.MONGODB_URI ? 'Loaded' : 'Undefined/Empty');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
const dbName = 'portfolio_db';

let dbConnected = false;

async function connectToMongoDB() {
  if (dbConnected) {
    return;
  }
  try {
    await client.connect();
    console.log("Successfully connected to MongoDB!");
    dbConnected = true;
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    throw error;
  }
}

function uploadToCloudinary(buffer, options) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
            if (error) return reject(error);
            resolve(result);
        });
        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
}

// --- Database Operations ---

async function readImagesFromDb() {
    await connectToMongoDB();
    const collection = client.db(dbName).collection('images');
    const images = await collection.find({}).sort({ order: 1, uploadDate: 1 }).toArray();
    return images.map(img => {
        return {
            ...img,
            id: img.id || img._id.toString()
        };
    });
}

async function insertImageToDb(image) {
    await connectToMongoDB();
    const collection = client.db(dbName).collection('images');
    const docToInsert = { ...image, _id: image.id };
    await collection.insertOne(docToInsert);
}

async function updateImageInDb(id, updates) {
    await connectToMongoDB();
    const collection = client.db(dbName).collection('images');
    await collection.updateOne({ _id: id }, { $set: updates });
}

async function deleteImageFromDb(id) {
    await connectToMongoDB();
    const collection = client.db(dbName).collection('images');
    await collection.deleteOne({ _id: id });
}

// Main serverless function handler
module.exports = async (req, res) => {
    try {
        await connectToMongoDB();
    } catch (error) {
        return res.status(500).json({ message: 'Database connection failed.', error: error.message });
    }

    if (req.method === 'POST') { // Add Image(s) (Upload)
        const form = new IncomingForm({
            maxFileSize: 20 * 1024 * 1024, // 20MB limit per file
            multiples: true, // IMPORTANT: Allows multiple file uploads
            allowEmptyFiles: false,
            minFileSize: 1
        });

        form.parse(req, async (err, fields, files) => {
            if (err) {
                console.error('Formidable Error parsing form (file upload issue):', err);
                let message = 'Error uploading image(s).';
                if (err.code === 1009) message = 'File size too large.';
                if (err.code === 1001) message = 'No file received or file is empty.';
                return res.status(400).json({ message, error: err.message });
            }

            const imageFiles = files.image || []; // This will be an array now
            if (!Array.isArray(imageFiles) || imageFiles.length === 0) {
                return res.status(400).json({ message: 'No image file(s) provided.' });
            }

            const altText = fields.altText && fields.altText[0] ? fields.altText[0] : '';
            const category = fields.category && fields.category[0] ? fields.category[0] : 'Uncategorized';

            const results = [];
            const existingImages = await readImagesFromDb(); // Get existing images once
            let maxOrder = existingImages.length > 0 ? Math.max(...existingImages.map(img => img.order || 0)) : 0;


            for (const imageFile of imageFiles) {
                let fileBuffer;
                try {
                    fileBuffer = await fs.readFile(imageFile.filepath);
                } catch (readErr) {
                    console.error(`FS Error reading temporary file ${imageFile.originalFilename}:`, readErr);
                    results.push({ filename: imageFile.originalFilename, success: false, error: 'Failed to read file.' });
                    await fs.unlink(imageFile.filepath).catch(() => {});
                    continue; // Skip to next file
                }

                try {
                    const originalFilename = imageFile.originalFilename;
                    const cloudinaryUploadResult = await uploadToCloudinary(fileBuffer, {
                        folder: 'portfolio_images',
                        public_id: `portfolio-${uuidv4()}-${path.parse(originalFilename).name}`,
                        resource_type: 'image',
                        altText: altText // Apply global altText to each image
                    });

                    // Clean up temp file
                    await fs.unlink(imageFile.filepath).catch(unlinkErr => {
                        console.warn(`Could not delete temporary file ${imageFile.filepath}: ${unlinkErr.message}`);
                    });
                    
                    maxOrder++; // Increment order for each new image
                    const newId = uuidv4();
                    const newImage = {
                        id: newId,
                        filename: originalFilename,
                        cloudinaryPublicId: cloudinaryUploadResult.public_id,
                        imageUrl: cloudinaryUploadResult.secure_url,
                        altText: altText || originalFilename.split('.')[0].replace(/[-_]/g, ' '),
                        category: category, // Apply global category to each image
                        order: maxOrder,
                        uploadDate: new Date().toISOString()
                    };

                    await insertImageToDb(newImage);
                    results.push({ filename: originalFilename, success: true, image: newImage });

                } catch (error) {
                    console.error(`API Error: Failed to upload ${imageFile.originalFilename} to Cloudinary or save to DB:`, error);
                    results.push({ filename: imageFile.originalFilename, success: false, error: error.message });
                    await fs.unlink(imageFile.filepath).catch(() => {}); // Clean up temp file on error
                }
            }

            const successfulUploads = results.filter(r => r.success).length;
            const failedUploads = results.length - successfulUploads;

            if (successfulUploads === results.length) {
                res.status(201).json({ message: `Successfully uploaded ${successfulUploads} image(s)!`, results });
            } else if (successfulUploads > 0) {
                res.status(207).json({ // 207 Multi-Status
                    message: `Uploaded ${successfulUploads} image(s), but ${failedUploads} failed.`,
                    results
                });
            } else {
                res.status(500).json({ message: `All ${failedUploads} image(s) failed to upload.`, results });
            }
        });

    } else if (req.method === 'GET') {
        try {
            const images = await readImagesFromDb();
            res.status(200).json(images);
        } catch (error) {
            console.error('API Error: Failed to retrieve images from DB:', error);
            res.status(500).json({ message: 'Failed to retrieve images.', error: error.message });
        }

    } else if (req.method === 'PUT') {
        try {
            const updates = JSON.parse(req.body);

            if (Array.isArray(updates.updates)) { // Batch reorder
                const operations = updates.updates.map(update => ({
                    updateOne: {
                        filter: { _id: update.id },
                        update: { $set: { order: update.order } }
                    }
                }));
                const collection = client.db(dbName).collection('images');
                await collection.bulkWrite(operations);
                const updatedImages = await readImagesFromDb();
                res.status(200).json({ message: 'Image order updated successfully!', images: updatedImages });
            } else { // Single image metadata update
                const { id, altText, category } = updates;
                if (!id) {
                    return res.status(400).json({ message: 'Image ID is required for update.' });
                }
                await updateImageInDb(id, { altText, category });
                const updatedImage = (await readImagesFromDb()).find(img => img.id === id);
                res.status(200).json({ message: 'Image metadata updated successfully!', image: updatedImage });
            }
        } catch (error) {
            console.error('API Error: Failed to update/reorder images in DB:', error);
            res.status(500).json({ message: 'Failed to update/reorder images.', error: error.message });
        }

    } else if (req.method === 'DELETE') {
        try {
            const { id } = JSON.parse(req.body);
            if (!id) {
                return res.status(400).json({ message: 'Image ID is required for deletion.' });
            }

            const collection = client.db(dbName).collection('images');
            const imageToDelete = await collection.findOne({ _id: id });

            if (!imageToDelete) {
                return res.status(404).json({ message: 'Image not found.' });
            }

            if (imageToDelete.cloudinaryPublicId) {
                try {
                    await cloudinary.uploader.destroy(imageToDelete.cloudinaryPublicId);
                    console.log(`Cloudinary image ${imageToDelete.cloudinaryPublicId} deleted successfully.`);
                } catch (cloudinaryError) {
                    console.warn(`Cloudinary Error: Failed to delete image from Cloudinary (${imageToDelete.cloudinaryPublicId}): ${cloudinaryError.message}`);
                }
            }

            await deleteImageFromDb(id);

            res.status(200).json({ message: 'Image deleted successfully!', id });

        } catch (error) {
            console.error('API Error: Failed to delete image:', error);
            res.status(500).json({ message: 'Failed to delete image.', error: error.message });
        }

    } else {
        res.status(405).json({ message: 'Method Not Allowed' });
    }
};