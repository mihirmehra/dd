// api/lead.js
import nodemailer from 'nodemailer';

export default async function handler(req, res) {
    if (req.method === 'POST') {
        const { name, email, phone, service } = req.body;

        if (!name || !email || !phone || !service) {
            return res.status(400).json({ status: 'error', message: 'All fields are required.' });
        }

        // Create a Nodemailer transporter using environment variables
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT, 10),
            secure: process.env.SMTP_PORT === '465', // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });

        // Email content
        const mailOptions = {
            from: process.env.EMAIL_FROM, // Sender address (must be configured on your SMTP server)
            to: process.env.EMAIL_TO_LEAD, // Receiver address for lead emails
            subject: `New Lead from DesignDuet Website: ${name}`,
            html: `
                <p>You have a new lead from the DesignDuet website consultation form!</p>
                <ul>
                    <li><strong>Name:</strong> ${name}</li>
                    <li><strong>Email:</strong> ${email}</li>
                    <li><strong>Phone:</strong> ${phone}</li>
                    <li><strong>Interested Service:</strong> ${service}</li>
                </ul>
                <p>Please contact them as soon as possible.</p>
            `,
        };

        try {
            await transporter.sendMail(mailOptions);
            return res.status(200).json({ status: 'success', message: 'Consultation request sent successfully!' });
        } catch (error) {
            console.error('Error sending lead email:', error);
            // Log the full error to Vercel logs for debugging
            if (error.response) {
                console.error('Nodemailer response:', error.response);
            }
            return res.status(500).json({ status: 'error', message: 'Failed to send consultation request. Please try again later.' });
        }
    } else {
        res.setHeader('Allow', ['POST']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}