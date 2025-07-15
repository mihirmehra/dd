<?php

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

require 'PHPMailer/Exception.php';
require 'PHPMailer/PHPMailer.php';
require 'PHPMailer/SMTP.php';


if ($_SERVER["REQUEST_METHOD"] == "POST") {
    // Collect form data
    $name = $_POST['name'];
    $email = $_POST['email'];
    $phone = $_POST['phone'];
    $service = $_POST['service'];

    // Create a new PHPMailer instance
    $mail = new PHPMailer(true);

    try {
        //Server settings
        $mail->isSMTP();
        $mail->Host       = 'smtp.gmail.com';
        $mail->SMTPAuth   = true;
        $mail->Username   = 'designduet329@gmail.com'; // Your Gmail address
        $mail->Password   = 'nmqv hrru exxy rapn';     // Your App password
        $mail->SMTPSecure = 'tls';
        $mail->Port       = 587;

        //Recipients
        $mail->setFrom('info@designduet.com', 'DesignDuet Lead'); // Your website's email address and name
        $mail->addAddress('info@designduet.com'); // Recipient for leads
        $mail->addAddress('designduet329@gmail.com'); // Additional recipient


        // Content
        $mail->isHTML(true);
        $mail->Subject = 'New Design Consultation Request from DesignDuet';
        $mail->Body    = "
            <h3>New Free Consultation Request</h3>
            <p><strong>Name:</strong> $name</p>
            <p><strong>Email:</strong> $email</p>
            <p><strong>Phone:</strong> $phone</p>
            <p><strong>Interested Service:</strong> $service</p>
        ";

        $mail->send();
        // Respond with success to the client-side JavaScript
        echo json_encode(['status' => 'success', 'message' => 'Your consultation request has been sent successfully!']);
    } catch (Exception $e) {
        // Respond with error to the client-side JavaScript
        echo json_encode(['status' => 'error', 'message' => "Message could not be sent. Mailer Error: {$mail->ErrorInfo}"]);
    }
} else {
    // Not a POST request
    echo json_encode(['status' => 'error', 'message' => 'Invalid request method.']);
}
?>