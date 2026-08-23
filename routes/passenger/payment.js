const express = require('express');
const axios = require('axios');
const Ride = require("../../models/Ride");
const { matchRide } = require("../../services/rideMatcher");
const { broadcastToRide } = require("../../services/socket");
const router = express.Router();
const crypto = require('crypto');

const WEBHOOK_SECRET_KEY = process.env.PAYMONGO_WEBHOOK_SECRET; 

router.post('/webhook', async (req, res) => {
    try {
        const signatureHeader = req.headers['paymongo-signature'];
        
        // 1. Verify the signature exists
        if (!signatureHeader || !WEBHOOK_SECRET_KEY) {
            console.warn("Missing signature header or webhook secret");
            return res.status(400).send('Bad Request');
        }
        // 2. Extract timestamp (t) and test signature (te)
        const parts = signatureHeader.split(',');
        let timestamp = '';
        let testSignature = '';
        parts.forEach(part => {
            const [key, value] = part.split('=');
            if (key === 't') timestamp = value;
            if (key === 'te') testSignature = value; 
            // Note: In Production/Live mode, it will be 'li' instead of 'te'
        });
        // 3. Construct the payload and hash it
        const payload = `${timestamp}.${req.rawBody.toString('utf8')}`;
        const expectedSignature = crypto
            .createHmac('sha256', WEBHOOK_SECRET_KEY)
            .update(payload)
            .digest('hex');
        // 4. Compare the signatures
        if (expectedSignature !== testSignature) {
            console.error("Invalid Webhook Signature. Expected:", expectedSignature, "Got:", testSignature);
            return res.status(401).send('Unauthorized');
        }
        // 5. If signature is valid, proceed with ride processing
        const event = req.body;
        if (event && event.data && event.data.attributes && event.data.attributes.type === 'link.payment.paid') {
            // In a link.payment.paid event, the Link object is at event.data.attributes.data
            const paymongoLinkId = event.data.attributes.data.id;

            console.log("Received payment for Link ID:", paymongoLinkId);

            const ride = await Ride.findOne({ paymongoLinkId: paymongoLinkId });
            
            if (ride && ride.status === 'payment_pending') {
                ride.status = 'pending';
                await ride.save();
                broadcastToRide(ride._id.toString(), 'ride_status_update', {
                    status: 'pending',
                    message: 'Payment verified! Looking for a driver...',
                    rideId: ride._id
                });
                
                matchRide(ride._id);
            }
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).send('Internal Server Error');
    }
});

module.exports = router;