/**
 * Shared email utility for all services
 * Uses SendGrid API with retry logic and exponential backoff
 */

const fetch = require('node-fetch');

// MIME type mapping for common file extensions
const MIME_TYPES = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

/**
 * Get MIME type from filename
 * @param {string} filename - The filename to get MIME type for
 * @returns {string} MIME type or default octet-stream
 */
function getMimeType(filename) {
  if (!filename) return 'application/octet-stream';
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Send email using SendGrid API with retry logic
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content of the email
 * @param {Object|Array} [options.attachments] - Single attachment or array of attachments
 * @param {string} [options.fromName='Find Target'] - Sender name
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @returns {Promise<{success: boolean}>}
 */
async function sendEmail({
  to,
  subject,
  html,
  attachments = null,
  fromName = 'Find Target',
  maxRetries = 3,
}) {
  const senderEmail = process.env.SENDER_EMAIL;

  if (!senderEmail) {
    throw new Error('SENDER_EMAIL environment variable not set');
  }

  if (!process.env.SENDGRID_API_KEY) {
    throw new Error('SENDGRID_API_KEY environment variable not set');
  }

  const emailData = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: senderEmail, name: fromName },
    subject: subject,
    content: [{ type: 'text/html', value: html }],
  };

  // Handle attachments (single or array)
  if (attachments) {
    const attachmentList = Array.isArray(attachments) ? attachments : [attachments];
    emailData.attachments = attachmentList.map((a) => ({
      filename: a.filename || a.name,
      content: a.content,
      type: a.type || getMimeType(a.filename || a.name),
      disposition: 'attachment',
    }));
  }

  // Retry logic with exponential backoff
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(emailData),
      });

      if (response.ok) {
        if (attempt > 1) {
          console.log(`  Email sent successfully on attempt ${attempt}`);
        }
        return { success: true };
      }

      const error = await response.text();
      lastError = new Error(`Email failed (attempt ${attempt}/${maxRetries}): ${error}`);
      console.error(lastError.message);

      // Don't retry on 4xx client errors (except 429 rate limit)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw lastError;
      }
    } catch (fetchError) {
      lastError = fetchError;
      console.error(`  Email attempt ${attempt}/${maxRetries} failed:`, fetchError.message);
    }

    // Exponential backoff: 2s, 4s, 8s
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000;
      console.log(`  Retrying email in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Email failed after all retries');
}

/**
 * Legacy function signature for backward compatibility
 * @deprecated Use sendEmail with object parameter instead
 */
async function sendEmailLegacy(to, subject, html, attachments = null, maxRetries = 3) {
  return sendEmail({ to, subject, html, attachments, maxRetries });
}

module.exports = {
  sendEmail,
  sendEmailLegacy,
  getMimeType,
};
