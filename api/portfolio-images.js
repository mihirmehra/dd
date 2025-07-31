// Import Node.js 'fs' (file system) and 'path' modules
const fs = require('fs');
const path = require('path');

// Define the directory where your images are stored.
// process.cwd() gets the current working directory, which is the root of your project (DD/)
const imagesDirectory = path.join(process.cwd(), 'assets', 'img');

module.exports = async (req, res) => {
  // Only allow GET requests to this endpoint
  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method Not Allowed', details: `The ${req.method} method is not allowed for this endpoint.` });
  }

  try {
    // Check if the directory exists before attempting to read it
    if (!fs.existsSync(imagesDirectory)) {
      console.warn(`Image directory not found: ${imagesDirectory}`);
      return res.status(404).json({ message: 'Image directory not found', directory: imagesDirectory });
    }

    // Read the contents (filenames) of the images directory asynchronously
    const files = await fs.promises.readdir(imagesDirectory);

    // Filter out only common image file extensions.
    // You can extend or modify this list as needed for your specific image types.
    const imageFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.ico'].includes(ext);
    });

    // Sort the image files alphabetically for consistent display
    imageFiles.sort();

    // Send the list of image file names as a JSON response
    res.status(200).json(imageFiles);

  } catch (error) {
    // Log the full error for server-side debugging
    console.error('Error listing images in API:', error);

    // Send a generic error message to the client for security, but provide details if useful
    res.status(500).json({
      message: 'Internal Server Error',
      error: 'Failed to retrieve image list.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined // Only show full error message in dev
    });
  }
};