const path = require('path');
const { IncomingForm } = require('formidable');
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const { Pool } = require('pg'); // Import PostgreSQL client library

// --- Cloudinary Configuration ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_SECRET_KEY,
  secure: true
});

// --- Supabase PostgreSQL Configuration ---
// The connection string is provided via Vercel Environment Variables.
const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL, // Use the environment variable set on Vercel
  ssl: {
    // This is often required for connecting to external databases like Supabase
    // from Vercel's serverless environment, as Vercel's functions might not
    // have the necessary root certificates by default.
    // For production, you might want to use a more robust SSL configuration
    // if your Supabase setup provides specific certificates.
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

// Read images from the database
async function readImagesFromDb() {
    const client = await pool.connect();
    try {
        // Order by 'order' column first, then by 'uploadDate' (if 'order' is the same)
        const result = await client.query('SELECT * FROM images ORDER BY "order" ASC, "uploadDate" ASC;');
        return result.rows; // Returns an array of image objects
    } finally {
        client.release(); // Release the client back to the pool
    }
}

// Insert a new image into the database
async function insertImageToDb(image) {
    const client = await pool.connect();
    try {
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
    } finally {
        client.release();
    }
}

// Update image metadata in the database
async function updateImageInDb(id, updates) {
    const client = await pool.connect();
    try {
        // Build the SET clause dynamically for flexibility
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
        if (updates.order !== undefined) {
            setClauses.push(`"order" = $${paramCounter++}`);
            values.push(updates.order);
        }

        if (setClauses.length === 0) {
            return; // Nothing to update
        }

        values.push(id); // Add id as the last parameter for WHERE clause
        const query = `UPDATE images SET ${setClauses.join(', ')} WHERE id = $${paramCounter};`;
        await client.query(query, values);
    } finally {
        client.release();
    }
}


// Delete an image from the database
async function deleteImageFromDb(id) {
    const client = await pool.connect();
    try {
        await client.query('DELETE FROM images WHERE id = $1;', [id]);
    } finally {
        client.release();
    }
}

// Main serverless function handler
module.exports = async (req, res) => {
    if (req.method === 'POST') { // Add Image (Upload)
        const form = new IncomingForm({
            maxFileSize: 20 * 1024 * 1024, // 20MB limit
            multiples: false,
            allowEmptyFiles: false,
            minFileSize: 1
        });

        form.parse(req, async (err, fields, files) => {
            if (err) {
                console.error('Error parsing form (file upload issue):', err);
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
                // `fs.readFile` is still needed here to read the temporary file created by formidable
                fileBuffer = await require('fs/promises').readFile(imageFile.filepath);
            } catch (readErr) {
                console.error('Error reading temporary file:', readErr);
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

                // Clean up the temporary file created by formidable
                await require('fs/promises').unlink(imageFile.filepath).catch(unlinkErr => {
                    console.warn(`Could not delete temporary file ${imageFile.filepath}: ${unlinkErr.message}`);
                });

                // Get current images to calculate the next 'order' value
                const images = await readImagesFromDb();
                const newId = uuidv4();
                const newImage = {
                    id: newId,
                    filename: originalFilename,
                    cloudinaryPublicId: cloudinaryUploadResult.public_id,
                    imageUrl: cloudinaryUploadResult.secure_url,
                    altText: altText || originalFilename.split('.')[0].replace(/[-_]/g, ' '),
                    category: category,
                    order: images.length > 0 ? Math.max(...images.map(img => img.order || 0)) + 1 : 1,
                    uploadDate: new Date().toISOString()
                };

                await insertImageToDb(newImage); // Save to Supabase

                res.status(201).json({ message: 'Image uploaded to Cloudinary and data saved successfully!', image: newImage });

            } catch (error) {
                console.error('Error uploading to Cloudinary or saving to DB:', error);
                // Attempt to clean up temp file if something went wrong after reading
                await require('fs/promises').unlink(imageFile.filepath).catch(() => {});
                return res.status(500).json({ message: 'Failed to upload image or save data to database.', error: error.message });
            }
        });

    } else if (req.method === 'GET') { // View All Images
        try {
            const images = await readImagesFromDb(); // Read from Supabase
            res.status(200).json(images);
        } catch (error) {
            console.error('Error retrieving images from DB:', error);
            res.status(500).json({ message: 'Failed to retrieve images from database.', error: error.message });
        }

    } else if (req.method === 'PUT') { // Update Image Metadata & Reorder (combined for simplicity)
        try {
            const updates = JSON.parse(req.body);
            // Handling reorder (array of updates)
            if (Array.isArray(updates.updates)) {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN;'); // Start transaction for batch update
                    for (const update of updates.updates) {
                        await client.query('UPDATE images SET "order" = $1 WHERE id = $2;', [update.order, update.id]);
                    }
                    await client.query('COMMIT;'); // Commit transaction
                    const updatedImages = await readImagesFromDb(); // Re-fetch sorted images
                    res.status(200).json({ message: 'Image order updated successfully!', images: updatedImages });
                } catch (txError) {
                    await client.query('ROLLBACK;'); // Rollback on error
                    throw txError;
                } finally {
                    client.release();
                }
            } else { // Single image metadata update
                const { id, altText, category } = updates;
                if (!id) {
                    return res.status(400).json({ message: 'Image ID is required for update.' });
                }
                await updateImageInDb(id, { altText, category }); // Update in DB
                // Optionally fetch the updated single image or all images again
                const updatedImage = (await readImagesFromDb()).find(img => img.id === id); // Find it in the fetched list
                res.status(200).json({ message: 'Image metadata updated successfully!', image: updatedImage });
            }
        } catch (error) {
            console.error('Error updating/reordering images in DB:', error);
            res.status(500).json({ message: 'Failed to update/reorder images in database.', error: error.message });
        }

    } else if (req.method === 'DELETE') { // Delete Image
        try {
            const { id } = JSON.parse(req.body);
            if (!id) {
                return res.status(400).json({ message: 'Image ID is required for deletion.' });
            }

            const client = await pool.connect();
            let imageToDelete;
            try {
                // Get image info before deleting from DB to get Cloudinary Public ID
                const result = await client.query('SELECT "cloudinaryPublicId" FROM images WHERE id = $1;', [id]);
                imageToDelete = result.rows[0];

                if (!imageToDelete) {
                    return res.status(404).json({ message: 'Image not found.' });
                }
            } finally {
                client.release();
            }


            // Delete from Cloudinary
            if (imageToDelete && imageToDelete.cloudinaryPublicId) {
                try {
                    await cloudinary.uploader.destroy(imageToDelete.cloudinaryPublicId);
                    console.log(`Cloudinary image ${imageToDelete.cloudinaryPublicId} deleted.`);
                } catch (cloudinaryError) {
                    console.warn(`Failed to delete image from Cloudinary (${imageToDelete.cloudinaryPublicId}): ${cloudinaryError.message}`);
                    // Log the warning but don't stop the process, as data should still be removed from DB
                }
            }

            await deleteImageFromDb(id); // Delete from Supabase

            res.status(200).json({ message: 'Image deleted successfully!', id });

        } catch (error) {
            console.error('Error deleting image from DB:', error);
            res.status(500).json({ message: 'Failed to delete image from database.', error: error.message });
        }

    } else {
        res.status(405).json({ message: 'Method Not Allowed' });
    }
};