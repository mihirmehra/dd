// api/contact.js
import nodemailer from 'nodemailer';

export default async function handler(req, res) {
    if (req.method === 'POST') {
        const { firstName, lastName, email, phone, service, message } = req.body;

        if (!firstName || !lastName || !email || !message) {
            return res.status(400).json({ status: 'error', message: 'First Name, Last Name, Email, and Project Details are required.' });
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

        const serviceList = Array.isArray(service) && service.length > 0
            ? service.map(s => `<li>${s.charAt(0).toUpperCase() + s.slice(1)} Design</li>`).join('')
            : '<li>No specific service selected</li>';

        // Email content
        const mailOptions = {
            from: process.env.EMAIL_FROM, // Sender address (must be configured on your SMTP server)
            to: process.env.EMAIL_TO_CONTACT, // Receiver address for general contact emails
            subject: `New Contact Message from DesignDuet Website: ${firstName} ${lastName}`,
            html: `
                <p>You have a new contact message from the DesignDuet website!</p>
                <ul>
                    <li><strong>Name:</strong> ${firstName} ${lastName}</li>
                    <li><strong>Email:</strong> ${email}</li>
                    <li><strong>Phone:</strong> ${phone || 'N/A'}</li>
                    <li><strong>Services Needed:</strong>
                        <ul>
                            ${serviceList}
                        </ul>
                    </li>
                    <li><strong>Project Details:</strong> ${message}</li>
                </ul>
            `,
        };

        try {
            await transporter.sendMail(mailOptions);
            return res.status(200).json({ status: 'success', message: 'Message sent successfully!' });
        } catch (error) {
            console.error('Error sending contact email:', error);
            // Log the full error to Vercel logs for debugging
            if (error.response) {
                console.error('Nodemailer response:', error.response);
            }
            return res.status(500).json({ status: 'error', message: 'Failed to send message. Please try again later.' });
        }
    } else {
        res.setHeader('Allow', ['POST']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}