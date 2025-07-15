// api/contact.js
const nodemailer = require('nodemailer');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });
    }

    const { firstName, lastName, email, phone, service, message } = req.body;

    if (!firstName || !lastName || !email || !message) {
        return res.status(400).json({ status: 'error', message: 'Missing required fields.' });
    }

    // Configure Nodemailer transporter using environment variables
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });

    const services = Array.isArray(service) ? service.join(', ') : service || 'N/A';

    const mailOptions = {
        from: process.env.EMAIL_FROM || `"${firstName} ${lastName}" <${email}>`, // Or a fixed 'from' address
        to: process.env.EMAIL_TO_CONTACT, // Your recipient email address for contact forms
        subject: `New Contact Form Submission from ${firstName} ${lastName}`,
        html: `
            <p><strong>Name:</strong> ${firstName} ${lastName}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Phone:</strong> ${phone || 'N/A'}</p>
            <p><strong>Service Needed:</strong> ${services}</p>
            <p><strong>Project Details:</strong></p>
            <p>${message}</p>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        res.status(200).json({ status: 'success', message: 'Your message has been sent successfully!' });
    } catch (error) {
        console.error('Error sending contact email:', error);
        res.status(500).json({ status: 'error', message: 'Failed to send message. Please try again later.' });
    }
};