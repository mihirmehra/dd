const path = require('path');
const { IncomingForm } = require('formidable');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const { Pool } = require('pg'); // PostgreSQL client library
const fs = require('fs/promises'); // For handling temporary files from formidable

// --- Cloudinary Configuration ---
// These environment variables MUST be set in your Vercel project settings.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_SECRET_KEY,
  secure: true
});

// --- Supabase PostgreSQL Configuration ---
// This environment variable MUST be set in your Vercel project settings.
// It will be process.env.SUPABASE_DB_URL as per your choice.
// We're adding a console.log here to help debug if it's still undefined on Vercel.
console.log('DEBUG: SUPABASE_DB_URL from environment:', process.env.SUPABASE_DB_URL ? 'Loaded' : 'Undefined/Empty');

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL, // Using your chosen variable name
  ssl: {
    // This is generally required for connecting to external databases like Supabase
    // from Vercel's serverless environment over SSL.
    rejectUnauthorized: false
  }
});

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

// --- Database Operations ---

/**
 * Reads all images from the Supabase database, ordered by 'order' and 'uploadDate'.
 * @returns {Array} An array of image objects.
 */
async function readImagesFromDb() {
    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT * FROM images ORDER BY "order" ASC, "uploadDate" ASC;');
        return result.rows;
    } catch (dbError) {
        console.error('Error in readImagesFromDb:', dbError);
        throw dbError; // Re-throw to be caught by the API handler
    } finally {
        if (client) client.release();
    }
}

/**
 * Inserts a new image record into the Supabase database.
 * @param {Object} image - The image object to insert.
 */
async function insertImageToDb(image) {
    let client;
    try {
        client = await pool.connect();
        const query = `
            INSERT INTO images (id, filename, "cloudinaryPublicId", "imageUrl", "altText", category, "order", "uploadDate")
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
        `;
        const values = [
            image.id,
            image.filename,
            image.cloudinaryPublicId,
            image.imageUrl,
            image.altText,
            image.category,
            image.order,
            image.uploadDate
        ];
        await client.query(query, values);
    } catch (dbError) {
        console.error('Error in insertImageToDb:', dbError);
        throw dbError;
    } finally {
        if (client) client.release();
    }
}

/**
 * Updates an existing image's metadata (altText, category, order) in the database.
 * @param {string} id - The ID of the image to update.
 * @param {Object} updates - An object containing fields to update (e.g., { altText: 'new text', category: 'new cat' }).
 */
async function updateImageInDb(id, updates) {
    let client;
    try {
        client = await pool.connect();
        const setClauses = [];
        const values = [];
        let paramCounter = 1;

        if (updates.altText !== undefined) {
            setClauses.push(`"altText" = $${paramCounter++}`);
            values.push(updates.altText);
        }
        if (updates.category !== undefined) {
            setClauses.push(`category = $${paramCounter++}`);
            values.push(updates.category);
        }
        if (updates.order !== undefined) { // For individual order updates, though batch is preferred for reorder
            setClauses.push(`"order" = $${paramCounter++}`);
            values.push(updates.order);
        }

        if (setClauses.length === 0) {
            return; // No updates provided
        }

        values.push(id); // Add id as the last parameter for WHERE clause
        const query = `UPDATE images SET ${setClauses.join(', ')} WHERE id = $${paramCounter};`;
        await client.query(query, values);
    } catch (dbError) {
        console.error('Error in updateImageInDb:', dbError);
        throw dbError;
    } finally {
        if (client) client.release();
    }
}

/**
 * Deletes an image record from the Supabase database.
 * @param {string} id - The ID of the image to delete.
 */
async function deleteImageFromDb(id) {
    let client;
    try {
        client = await pool.connect();
        await client.query('DELETE FROM images WHERE id = $1;', [id]);
    } catch (dbError) {
        console.error('Error in deleteImageFromDb:', dbError);
        throw dbError;
    } finally {
        if (client) client.release();
    }
}

// Main serverless function handler
module.exports = async (req, res) => {
    // Handle POST request for image upload
    if (req.method === 'POST') {
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
                // Read the temporary file created by formidable into a buffer
                fileBuffer = await fs.readFile(imageFile.filepath);
            } catch (readErr) {
                console.error('FS Error reading temporary file:', readErr);
                return res.status(500).json({ message: 'Failed to read uploaded file.', error: readErr.message });
            }

            // Extract metadata from form fields
            const altText = fields.altText && fields.altText[0] ? fields.altText[0] : '';
            const category = fields.category && fields.category[0] ? fields.category[0] : 'Uncategorized';
            const originalFilename = imageFile.originalFilename;

            try {
                // Upload the image buffer to Cloudinary
                const cloudinaryUploadResult = await uploadToCloudinary(fileBuffer, {
                    folder: 'portfolio_images', // Optional: Folder in your Cloudinary account
                    public_id: `portfolio-${uuidv4()}-${path.parse(originalFilename).name}`, // Unique public ID
                    resource_type: 'image', // Ensure it's treated as an image
                    altText: altText // Cloudinary can store this as metadata
                });

                // Clean up the temporary file created by formidable immediately after processing
                await fs.unlink(imageFile.filepath).catch(unlinkErr => {
                    console.warn(`Could not delete temporary file ${imageFile.filepath}: ${unlinkErr.message}`);
                });

                // Get current images to calculate the next 'order' value based on existing items
                const images = await readImagesFromDb();
                const newId = uuidv4();
                const newImage = {
                    id: newId,
                    filename: originalFilename, // Store original name for reference
                    cloudinaryPublicId: cloudinaryUploadResult.public_id, // Store Cloudinary's public ID
                    imageUrl: cloudinaryUploadResult.secure_url, // Store the secure public URL
                    altText: altText || originalFilename.split('.')[0].replace(/[-_]/g, ' '),
                    category: category,
                    order: images.length > 0 ? Math.max(...images.map(img => img.order || 0)) + 1 : 1, // Simple sequential order
                    uploadDate: new Date().toISOString() // Store upload timestamp
                };

                // Insert the new image metadata into Supabase
                await insertImageToDb(newImage);

                res.status(201).json({ message: 'Image uploaded to Cloudinary and data saved successfully!', image: newImage });

            } catch (error) {
                console.error('API Error: Failed to upload to Cloudinary or save to DB:', error);
                // Attempt to clean up temp file if something went wrong after reading, but before success
                await fs.unlink(imageFile.filepath).catch(() => {});
                return res.status(500).json({ message: 'Failed to process image upload.', error: error.message });
            }
        });

    } else if (req.method === 'GET') { // Handle GET request for fetching all images
        try {
            const images = await readImagesFromDb(); // Fetch all images from Supabase
            res.status(200).json(images);
        } catch (error) {
            console.error('API Error: Failed to retrieve images from DB:', error);
            res.status(500).json({ message: 'Failed to retrieve images.', error: error.message });
        }

    } else if (req.method === 'PUT') { // Handle PUT request for updating image metadata or reordering
        try {
            const updates = JSON.parse(req.body);

            // If 'updates' is an array, it's a batch reorder request
            if (Array.isArray(updates.updates)) {
                let client;
                try {
                    client = await pool.connect();
                    await client.query('BEGIN;'); // Start transaction for atomicity
                    for (const update of updates.updates) {
                        await client.query('UPDATE images SET "order" = $1 WHERE id = $2;', [update.order, update.id]);
                    }
                    await client.query('COMMIT;'); // Commit transaction if all updates succeed
                    const updatedImages = await readImagesFromDb(); // Re-fetch sorted images after update
                    res.status(200).json({ message: 'Image order updated successfully!', images: updatedImages });
                } catch (txError) {
                    if (client) await client.query('ROLLBACK;'); // Rollback on any error during transaction
                    throw txError;
                } finally {
                    if (client) client.release();
                }
            } else { // Otherwise, it's a single image metadata update
                const { id, altText, category } = updates;
                if (!id) {
                    return res.status(400).json({ message: 'Image ID is required for update.' });
                }
                await updateImageInDb(id, { altText, category }); // Update in Supabase
                // Re-fetch the updated image or all images for the response
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

            let imageToDelete;
            let client;
            try {
                client = await pool.connect();
                // Get Cloudinary Public ID before deleting the record from DB
                const result = await client.query('SELECT "cloudinaryPublicId" FROM images WHERE id = $1;', [id]);
                imageToDelete = result.rows[0];

                if (!imageToDelete) {
                    return res.status(404).json({ message: 'Image not found.' });
                }
            } catch (dbError) {
                console.error('API Error: Error finding image for deletion in DB:', dbError);
                throw dbError;
            } finally {
                if (client) client.release();
            }

            // Delete from Cloudinary using its public ID
            if (imageToDelete && imageToDelete.cloudinaryPublicId) {
                try {
                    await cloudinary.uploader.destroy(imageToDelete.cloudinaryPublicId);
                    console.log(`Cloudinary image ${imageToDelete.cloudinaryPublicId} deleted successfully.`);
                } catch (cloudinaryError) {
                    console.warn(`Cloudinary Error: Failed to delete image from Cloudinary (${imageToDelete.cloudinaryPublicId}): ${cloudinaryError.message}`);
                    // Log warning but proceed to delete from DB, as Cloudinary deletion is not critical path
                }
            }

            // Delete the image record from Supabase
            await deleteImageFromDb(id);

            res.status(200).json({ message: 'Image deleted successfully!', id });

        } catch (error) {
            console.error('API Error: Failed to delete image:', error);
            res.status(500).json({ message: 'Failed to delete image.', error: error.message });
        }

    } else {
        // Handle unsupported HTTP methods
        res.status(405).json({ message: 'Method Not Allowed' });
    }
};