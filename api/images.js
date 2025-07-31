const fs = require('fs/promises');
const path = require('path');
const { IncomingForm } = require('formidable');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2; // Import Cloudinary SDK
const streamifier = require('streamifier'); // To pipe buffer to Cloudinary

// --- Cloudinary Configuration ---
// It's best practice to get these from environment variables on Vercel
// You've provided them, so make sure they are set in your Vercel project settings
// (under Project Settings -> Environment Variables)
// For local development, you'd use a .env file and dotenv package.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_SECRET_KEY,
  secure: true // Use HTTPS URLs
});

// We no longer need IMAGES_DIR for saving uploaded files permanently
// const IMAGES_DIR = path.join(process.cwd(), 'assets', 'img'); // No longer used for saving uploads

const DATA_FILE = path.join(process.cwd(), 'data', 'images.json');

// Helper to read images data
async function readImagesData() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { // File not found, return empty array
            console.warn('images.json not found, initializing with empty array.');
            return [];
        }
        console.error('Error reading images data:', error);
        throw new Error('Failed to read image data.');
    }
}

// Helper to write images data
async function writeImagesData(data) {
    try {
        // Ensure the data directory exists
        await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
        await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error('Error writing images data:', error);
        throw new Error('Failed to write image data.');
    }
}

// Helper function to upload buffer to Cloudinary
function uploadToCloudinary(buffer, options) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
            if (error) return reject(error);
            resolve(result);
        });
        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
}

module.exports = async (req, res) => {
    if (req.method === 'POST') { // Add Image (Upload)
        const form = new IncomingForm({
            // formidable will still write to a temp directory, which is fine
            // We just won't 'rename' it to assets/img permanently
            maxFileSize: 20 * 1024 * 1024, // 20MB limit (Cloudinary's free tier has limits)
            multiples: false,
            allowEmptyFiles: false,
            minFileSize: 1 // Ensure some file content
        });

        form.parse(req, async (err, fields, files) => {
            if (err) {
                console.error('Error parsing form (file upload issue):', err);
                // More specific error messages for formidable errors
                let message = 'Error uploading image.';
                if (err.code === 1009) message = 'File size too large.'; // Max file size exceeded
                if (err.code === 1001) message = 'No file received or file is empty.'; // No file or empty file
                return res.status(400).json({ message, error: err.message });
            }

            const imageFile = files.image && files.image[0];

            if (!imageFile) {
                return res.status(400).json({ message: 'No image file provided.' });
            }

            // Read the temporary file into a buffer
            let fileBuffer;
            try {
                fileBuffer = await fs.readFile(imageFile.filepath);
            } catch (readErr) {
                console.error('Error reading temporary file:', readErr);
                return res.status(500).json({ message: 'Failed to read uploaded file.', error: readErr.message });
            }

            // Extract metadata from form fields
            const altText = fields.altText && fields.altText[0] ? fields.altText[0] : '';
            const category = fields.category && fields.category[0] ? fields.category[0] : 'Uncategorized';
            const originalFilename = imageFile.originalFilename;

            try {
                // Upload to Cloudinary
                const cloudinaryUploadResult = await uploadToCloudinary(fileBuffer, {
                    folder: 'portfolio_images', // Optional: Folder in your Cloudinary account
                    public_id: `portfolio-${uuidv4()}-${path.parse(originalFilename).name}`, // Unique public ID
                    resource_type: 'image',
                    altText: altText // Cloudinary can store this as metadata, though we save it in JSON too
                });

                // Clean up the temporary file created by formidable
                await fs.unlink(imageFile.filepath).catch(unlinkErr => {
                    console.warn(`Could not delete temporary file ${imageFile.filepath}: ${unlinkErr.message}`);
                });

                const images = await readImagesData();
                const newId = uuidv4();
                const newImage = {
                    id: newId,
                    filename: originalFilename, // We can store the original name
                    cloudinaryPublicId: cloudinaryUploadResult.public_id, // Store Cloudinary's public ID
                    imageUrl: cloudinaryUploadResult.secure_url, // Store the secure URL
                    altText: altText || originalFilename.split('.')[0].replace(/[-_]/g, ' '),
                    category: category,
                    order: images.length > 0 ? Math.max(...images.map(img => img.order || 0)) + 1 : 1,
                    uploadDate: new Date().toISOString()
                };
                images.push(newImage);
                await writeImagesData(images);

                res.status(201).json({ message: 'Image uploaded to Cloudinary and data saved successfully!', image: newImage });

            } catch (uploadError) {
                console.error('Error uploading to Cloudinary or saving data:', uploadError);
                // Attempt to clean up temp file if something went wrong after reading
                await fs.unlink(imageFile.filepath).catch(() => {});
                return res.status(500).json({ message: 'Failed to upload image or save data.', error: uploadError.message });
            }
        });

    } else if (req.method === 'GET') { // View All Images
        try {
            const images = await readImagesData();
            // Sort by order first, then by uploadDate
            images.sort((a, b) => (a.order || 0) - (b.order || 0) || new Date(a.uploadDate).getTime() - new Date(b.uploadDate).getTime());
            res.status(200).json(images);
        } catch (error) {
            res.status(500).json({ message: 'Failed to retrieve images.', error: error.message });
        }

    } else if (req.method === 'PUT') { // Update Image Metadata & Reorder (combined for simplicity)
        try {
            const updates = JSON.parse(req.body); // Can be a single object or an array for reorder
            let images = await readImagesData();

            if (Array.isArray(updates.updates)) { // Batch update for reordering
                const updatedIds = new Set(updates.updates.map(u => u.id));
                images = images.map(img => {
                    const update = updates.updates.find(u => u.id === img.id);
                    return update ? { ...img, order: update.order } : img;
                });
                // Sort immediately after reorder for consistency
                images.sort((a, b) => (a.order || 0) - (b.order || 0) || new Date(a.uploadDate).getTime() - new Date(b.uploadDate).getTime());
                await writeImagesData(images);
                res.status(200).json({ message: 'Image order updated successfully!', images });

            } else { // Single image metadata update
                const { id, altText, category } = updates; // No 'filename' or 'order' update here
                if (!id) {
                    return res.status(400).json({ message: 'Image ID is required for update.' });
                }

                const index = images.findIndex(img => img.id === id);
                if (index === -1) {
                    return res.status(404).json({ message: 'Image not found.' });
                }

                if (altText !== undefined) images[index].altText = altText;
                if (category !== undefined) images[index].category = category;
                // Note: We don't allow filename or order change via this singular PUT.
                // Order is handled by the batch PUT; filename would require Cloudinary API rename.

                await writeImagesData(images);
                res.status(200).json({ message: 'Image metadata updated successfully!', image: images[index] });
            }

        } catch (error) {
            console.error('Error updating/reordering images:', error);
            res.status(500).json({ message: 'Failed to update/reorder images.', error: error.message });
        }

    } else if (req.method === 'DELETE') { // Delete Image
        try {
            const { id } = JSON.parse(req.body);
            if (!id) {
                return res.status(400).json({ message: 'Image ID is required for deletion.' });
            }

            let images = await readImagesData();
            const imageToDelete = images.find(img => img.id === id);

            if (!imageToDelete) {
                return res.status(404).json({ message: 'Image not found.' });
            }

            // Delete from Cloudinary
            if (imageToDelete.cloudinaryPublicId) {
                try {
                    await cloudinary.uploader.destroy(imageToDelete.cloudinaryPublicId);
                    console.log(`Cloudinary image ${imageToDelete.cloudinaryPublicId} deleted.`);
                } catch (cloudinaryError) {
                    console.warn(`Failed to delete image from Cloudinary (${imageToDelete.cloudinaryPublicId}): ${cloudinaryError.message}`);
                    // Log the warning but don't stop the process, as data should still be removed
                }
            }

            const newImages = images.filter(img => img.id !== id);
            await writeImagesData(newImages);

            res.status(200).json({ message: 'Image deleted successfully!', id });

        } catch (error) {
            console.error('Error deleting image:', error);
            res.status(500).json({ message: 'Failed to delete image.', error: error.message });
        }

    } else {
        res.status(405).json({ message: 'Method Not Allowed' });
    }
};