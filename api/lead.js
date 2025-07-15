// api/lead.js
const nodemailer = require('nodemailer');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });
    }

    const { name, email, phone, service } = req.body;

    if (!name || !email || !phone || !service) {
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

    const mailOptions = {
        from: process.env.EMAIL_FROM || `"${name}" <${email}>`, // Or a fixed 'from' address
        to: process.env.EMAIL_TO_LEAD, // Your recipient email address for lead forms
        subject: `New Lead Consultation Request from ${name}`,
        html: `
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Phone:</strong> ${phone}</p>
            <p><strong>Interested Service:</strong> ${service}</p>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        res.status(200).json({ status: 'success', message: 'Your consultation request has been sent successfully!' });
    } catch (error) {
        console.error('Error sending lead email:', error);
        res.status(500).json({ status: 'error', message: 'Failed to send consultation request. Please try again later.' });
    }
};