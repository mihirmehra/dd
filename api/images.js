const fs = require('fs/promises'); // Use promise-based fs
const path = require('path');
const { IncomingForm } = require('formidable'); // For file uploads
const { v4: uuidv4 } = require('uuid'); // For unique IDs

const IMAGES_DIR = path.join(process.cwd(), 'assets', 'img');
const DATA_FILE = path.join(process.cwd(), 'data', 'images.json');

// Helper to read images data
async function readImagesData() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { // File not found
            return [];
        }
        console.error('Error reading images data:', error);
        throw new Error('Failed to read image data.');
    }
}

// Helper to write images data
async function writeImagesData(data) {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error('Error writing images data:', error);
        throw new Error('Failed to write image data.');
    }
}

module.exports = async (req, res) => {
    // Ensure IMAGES_DIR exists
    try {
        await fs.mkdir(IMAGES_DIR, { recursive: true });
    } catch (e) {
        console.error('Could not create images directory:', e);
        return res.status(500).json({ message: 'Server configuration error: Image directory not accessible.' });
    }

    if (req.method === 'POST') { // Add Image (Upload)
        const form = new IncomingForm({
            uploadDir: IMAGES_DIR,
            keepExtensions: true,
            maxFileSize: 10 * 1024 * 1024, // 10MB limit
            multiples: false,
        });

        form.parse(req, async (err, fields, files) => {
            if (err) {
                console.error('Error parsing form:', err);
                return res.status(400).json({ message: 'Error uploading image.', error: err.message });
            }

            const imageFile = files.image && files.image[0]; // Access the first file if multiples is false

            if (!imageFile) {
                return res.status(400).json({ message: 'No image file provided.' });
            }

            const oldPath = imageFile.filepath;
            const newFilename = `${uuidv4()}${path.extname(imageFile.originalFilename)}`;
            const newPath = path.join(IMAGES_DIR, newFilename);

            try {
                // Move the uploaded file to the desired location with a new name
                await fs.rename(oldPath, newPath);

                const images = await readImagesData();
                const newId = uuidv4();
                const newImage = {
                    id: newId,
                    filename: newFilename,
                    altText: fields.altText && fields.altText[0] ? fields.altText[0] : newFilename.split('.')[0].replace(/[-_]/g, ' '),
                    category: fields.category && fields.category[0] ? fields.category[0] : 'Uncategorized',
                    order: images.length > 0 ? Math.max(...images.map(img => img.order)) + 1 : 1, // Simple sequential order
                    uploadDate: new Date().toISOString()
                };
                images.push(newImage);
                await writeImagesData(images);

                res.status(201).json({ message: 'Image uploaded and data saved successfully!', image: newImage });

            } catch (fileError) {
                console.error('Error moving file or saving data:', fileError);
                // Clean up partially uploaded file if rename fails
                await fs.unlink(oldPath).catch(() => {}); // Don't throw if unlink fails
                return res.status(500).json({ message: 'Failed to process image upload.', error: fileError.message });
            }
        });

    } else if (req.method === 'GET') { // View All Images
        try {
            const images = await readImagesData();
            // Sort by order first, then by filename if order is the same
            images.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));
            res.status(200).json(images);
        } catch (error) {
            res.status(500).json({ message: 'Failed to retrieve images.', error: error.message });
        }

    } else if (req.method === 'PUT') { // Update Image Metadata
        try {
            const { id, filename, altText, category, order } = JSON.parse(req.body);
            if (!id) {
                return res.status(400).json({ message: 'Image ID is required for update.' });
            }

            let images = await readImagesData();
            const index = images.findIndex(img => img.id === id);

            if (index === -1) {
                return res.status(404).json({ message: 'Image not found.' });
            }

            // Only update fields that are provided
            if (filename) images[index].filename = filename; // Note: This doesn't rename the file
            if (altText !== undefined) images[index].altText = altText;
            if (category !== undefined) images[index].category = category;
            if (order !== undefined) images[index].order = parseInt(order, 10);

            await writeImagesData(images);
            res.status(200).json({ message: 'Image updated successfully!', image: images[index] });

        } catch (error) {
            console.error('Error updating image:', error);
            res.status(500).json({ message: 'Failed to update image.', error: error.message });
        }

    } else if (req.method === 'DELETE') { // Delete Image
        try {
            const { id } = JSON.parse(req.body); // Expecting ID in the body for DELETE
            if (!id) {
                return res.status(400).json({ message: 'Image ID is required for deletion.' });
            }

            let images = await readImagesData();
            const imageToDelete = images.find(img => img.id === id);

            if (!imageToDelete) {
                return res.status(404).json({ message: 'Image not found.' });
            }

            const newImages = images.filter(img => img.id !== id);
            await writeImagesData(newImages);

            // Delete the physical file
            const filePath = path.join(IMAGES_DIR, imageToDelete.filename);
            try {
                await fs.unlink(filePath);
            } catch (fileError) {
                console.warn(`Could not delete physical file ${filePath}: ${fileError.message}`);
                // Don't fail the entire request if file deletion fails, as data is already removed
            }

            res.status(200).json({ message: 'Image deleted successfully!', id });

        } catch (error) {
            console.error('Error deleting image:', error);
            res.status(500).json({ message: 'Failed to delete image.', error: error.message });
        }

    } else {
        res.status(405).json({ message: 'Method Not Allowed' });
    }
};