<?php

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

require 'PHPMailer/Exception.php';
require 'PHPMailer/PHPMailer.php';
require 'PHPMailer/SMTP.php';


if ($_SERVER["REQUEST_METHOD"] == "POST") {
    // Collect form data
    $firstName = $_POST['firstName'];
    $lastName = $_POST['lastName'];
    $email = $_POST['email'];
    $phone = $_POST['phone'];
    $services = isset($_POST['service']) ? (array)$_POST['service'] : []; // Services can be multiple
    $message = $_POST['message'];

    $full_name = $firstName . ' ' . $lastName;
    $service_list = !empty($services) ? implode(', ', array_map('ucfirst', $services)) : 'N/A';

    // Create a new PHPMailer instance
    $mail = new PHPMailer(true);

    try {
        //Server settings
        $mail->isSMTP();
        $mail->Host       = 'smtp.gmail.com';
        $mail->SMTPAuth   = true;
        $mail->Username   = 'mihirmehrajio@gmail.com'; // Your Gmail address
        $mail->Password   = 'zwmq uerj yqwj acfv';     // Your App password
        $mail->SMTPSecure = 'tls';
        $mail->Port       = 587;

        //Recipients
        $mail->setFrom('info@designduet.com', 'DesignDuet Contact'); // Your website's email address and name
        $mail->addAddress('info@designduet.com'); // Recipient for contact form
        $mail->addAddress('mihirmehrajio@gmail.com'); // Additional recipient


        // Content
        $mail->isHTML(true);
        $mail->Subject = 'New Project Inquiry from DesignDuet Website';
        $mail->Body    = "
            <h3>New Project Inquiry</h3>
            <p><strong>Name:</strong> $full_name</p>
            <p><strong>Email:</strong> $email</p>
            <p><strong>Phone:</strong> $phone</p>
            <p><strong>Services Needed:</strong> $service_list</p>
            <p><strong>Project Details:</strong><br>$message</p>
        ";

        $mail->send();
        // Respond with success to the client-side JavaScript
        echo json_encode(['status' => 'success', 'message' => 'Your message has been sent successfully!']);
    } catch (Exception $e) {
        // Respond with error to the client-side JavaScript
        echo json_encode(['status' => 'error', 'message' => "Message could not be sent. Mailer Error: {$mail->ErrorInfo}"]);
    }
} else {
    // Not a POST request
    echo json_encode(['status' => 'error', 'message' => 'Invalid request method.']);
}
?>