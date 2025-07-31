const path = require('path');
const { IncomingForm } = require('formidable');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const { MongoClient, ObjectId } = require('mongodb'); // Import MongoDB client
const fs = require('fs/promises'); // For handling temporary files from formidable

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
const dbName = 'portfolio_db'; // Explicitly define your database name here

let dbConnected = false;

// Function to connect to MongoDB. Call this once.
async function connectToMongoDB() {
  if (dbConnected) {
    return; // Already connected
  }
  try {
    await client.connect();
    console.log("Successfully connected to MongoDB!");
    dbConnected = true;
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error);
    throw error; // Re-throw to indicate connection failure
  }
}

// Helper function to upload buffer to Cloudinary (THIS IS THE MISSING/FIXED PART)
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

/**
 * Reads all images from the MongoDB collection.
 * @returns {Array} An array of image objects.
 */
async function readImagesFromDb() {
    await connectToMongoDB();
    const collection = client.db(dbName).collection('images');
    const images = await collection.find({}).sort({ order: 1, uploadDate: 1 }).toArray();
    return images.map(img => {
        return {
            ...img,
            id: img.id || img._id.toString() // Prefer explicit 'id', fallback to _id string
        };
    });
}

/**
 * Inserts a new image record into the MongoDB collection.
 * @param {Object} image - The image object to insert.
 */
async function insertImageToDb(image) {
    await connectToMongoDB();
    const collection = client.db(dbName).collection('images');
    // Use the UUID 'id' directly as MongoDB's _id for simpler lookups later
    const docToInsert = { ...image, _id: image.id };
    await collection.insertOne(docToInsert);
}

/**
 * Updates an existing image's metadata (altText, category, order) in the database.
 * @param {string} id - The ID (UUID) of the image to update.
 * @param {Object} updates - An object containing fields to update.
 */
async function updateImageInDb(id, updates) {
    await connectToMongoDB();
    const collection = client.db(dbName).collection('images');
    // Find by the custom 'id' field (which we are storing as _id)
    await collection.updateOne({ _id: id }, { $set: updates });
}

/**
 * Deletes an image record from the MongoDB collection.
 * @param {string} id - The ID (UUID) of the image to delete.
 */
async function deleteImageFromDb(id) {
    await connectToMongoDB();
    const collection = client.db(dbName).collection('images');
    // Delete by the custom 'id' field (which we are storing as _id)
    await collection.deleteOne({ _id: id });
}

// Main serverless function handler
module.exports = async (req, res) => {
    try {
        await connectToMongoDB();
    } catch (error) {
        return res.status(500).json({ message: 'Database connection failed.', error: error.message });
    }

    if (req.method === 'POST') { // Add Image (Upload)
        const form = new IncomingForm({
            maxFileSize: 20 * 1024 * 1024, // 20MB limit for uploads
            multiples: false,
            allowEmptyFiles: false,
            minFileSize: 1
        });

        form.parse(req, async (err, fields, files) => {
            if (err) {
                console.error('Formidable Error parsing form (file upload issue):', err);
                let message = 'Error uploading image.';
                if (err.code === 1009) message = 'File size too large.';
                if (err.code === 1001) message = 'No file received or file is empty.';
                return res.status(400).json({ message, error: err.message });
            }

            const imageFile = files.image && files.image[0];

            if (!imageFile) {
                return res.status(400).json({ message: 'No image file provided.' });
            }

            let fileBuffer;
            try {
                fileBuffer = await fs.readFile(imageFile.filepath);
            } catch (readErr) {
                console.error('FS Error reading temporary file:', readErr);
                return res.status(500).json({ message: 'Failed to read uploaded file.', error: readErr.message });
            }

            const altText = fields.altText && fields.altText[0] ? fields.altText[0] : '';
            const category = fields.category && fields.category[0] ? fields.category[0] : 'Uncategorized';
            const originalFilename = imageFile.originalFilename;

            try {
                const cloudinaryUploadResult = await uploadToCloudinary(fileBuffer, {
                    folder: 'portfolio_images',
                    public_id: `portfolio-${uuidv4()}-${path.parse(originalFilename).name}`,
                    resource_type: 'image',
                    altText: altText
                });

                await fs.unlink(imageFile.filepath).catch(unlinkErr => {
                    console.warn(`Could not delete temporary file ${imageFile.filepath}: ${unlinkErr.message}`);
                });

                const images = await readImagesFromDb();
                const newId = uuidv4();
                const newImage = {
                    id: newId, // Storing UUID in 'id' field
                    filename: originalFilename,
                    cloudinaryPublicId: cloudinaryUploadResult.public_id,
                    imageUrl: cloudinaryUploadResult.secure_url,
                    altText: altText || originalFilename.split('.')[0].replace(/[-_]/g, ' '),
                    category: category,
                    order: images.length > 0 ? Math.max(...images.map(img => img.order || 0)) + 1 : 1,
                    uploadDate: new Date().toISOString()
                };

                await insertImageToDb(newImage);

                res.status(201).json({ message: 'Image uploaded to Cloudinary and data saved successfully!', image: newImage });

            } catch (error) {
                console.error('API Error: Failed to upload to Cloudinary or save to DB:', error);
                await fs.unlink(imageFile.filepath).catch(() => {}); // Clean up temp file on error
                return res.status(500).json({ message: 'Failed to process image upload.', error: error.message });
            }
        });

    } else if (req.method === 'GET') { // Handle GET request for fetching all images
        try {
            const images = await readImagesFromDb();
            res.status(200).json(images);
        } catch (error) {
            console.error('API Error: Failed to retrieve images from DB:', error);
            res.status(500).json({ message: 'Failed to retrieve images.', error: error.message });
        }

    } else if (req.method === 'PUT') { // Handle PUT request for updating image metadata or reordering
        try {
            const updates = JSON.parse(req.body);

            if (Array.isArray(updates.updates)) { // Batch reorder
                const operations = updates.updates.map(update => ({
                    updateOne: {
                        filter: { _id: update.id }, // Use _id for filtering
                        update: { $set: { order: update.order } }
                    }
                }));
                const collection = client.db(dbName).collection('images');
                await collection.bulkWrite(operations); // Perform multiple updates efficiently
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

    } else if (req.method === 'DELETE') { // Handle DELETE request for removing an image
        try {
            const { id } = JSON.parse(req.body);
            if (!id) {
                return res.status(400).json({ message: 'Image ID is required for deletion.' });
            }

            const collection = client.db(dbName).collection('images');
            // Find image to get Cloudinary Public ID before deleting from DB
            const imageToDelete = await collection.findOne({ _id: id }); // Use _id for lookup

            if (!imageToDelete) {
                return res.status(404).json({ message: 'Image not found.' });
            }

            // Delete from Cloudinary
            if (imageToDelete.cloudinaryPublicId) {
                try {
                    await cloudinary.uploader.destroy(imageToDelete.cloudinaryPublicId);
                    console.log(`Cloudinary image ${imageToDelete.cloudinaryPublicId} deleted successfully.`);
                } catch (cloudinaryError) {
                    console.warn(`Cloudinary Error: Failed to delete image from Cloudinary (${imageToDelete.cloudinaryPublicId}): ${cloudinaryError.message}`);
                }
            }

            await deleteImageFromDb(id); // Delete from MongoDB

            res.status(200).json({ message: 'Image deleted successfully!', id });

        } catch (error) {
            console.error('API Error: Failed to delete image:', error);
            res.status(500).json({ message: 'Failed to delete image.', error: error.message });
        }

    } else {
        res.status(405).json({ message: 'Method Not Allowed' });
    }
};