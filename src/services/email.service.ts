import nodemailer, { type Transporter } from 'nodemailer'
import { logger } from '../utils/logger'

interface SendResetEmailOptions {
  to: string
  resetUrl: string
  fullName?: string
}

function getMailConfig() {
  const host = process.env.MAIL_HOST || process.env.SMTP_HOST || 'smtp.gmail.com'
  const port = Number(process.env.MAIL_PORT || process.env.SMTP_PORT || 465)
  const user = (process.env.MAIL_USER || process.env.SMTP_USER || '').trim()
  const pass = (process.env.MAIL_PASS || process.env.SMTP_PASS || '').trim()
  const from = process.env.MAIL_FROM || process.env.EMAIL_FROM || `"Snowflex" <${user || 'no-reply@snowflex.local'}>`

  return { host, port, user, pass, from, isConfigured: Boolean(user && pass) }
}

export function createMailTransporter(): Transporter | null {
  const config = getMailConfig()
  if (!config.isConfigured) {
    return null
  }

  const isSecure = config.port === 465
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: isSecure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    tls: {
      rejectUnauthorized: false,
    },
  })
}

export async function verifyMailSetup(): Promise<boolean> {
  const config = getMailConfig()
  if (!config.isConfigured) {
    logger.warn('[EMAIL] MAIL_USER / MAIL_PASS is not set in .env. Reset links will be printed in console during local development.')
    return false
  }

  try {
    const transporter = createMailTransporter()
    if (!transporter) {
      logger.warn('[EMAIL] Transporter could not be created.')
      return false
    }
    await transporter.verify()
    logger.success(`[EMAIL] SMTP connection verified successfully (host: ${config.host}, port: ${config.port}, user: ${config.user})`)
    return true
  } catch (error) {
    logger.error(`[EMAIL] SMTP verification failed for ${config.host}:${config.port}. Check MAIL_USER and MAIL_PASS in .env.`, error)
    return false
  }
}

export async function sendPasswordResetEmail({ to, resetUrl, fullName }: SendResetEmailOptions): Promise<void> {
  const config = getMailConfig()
  const greetingName = fullName?.trim() || 'there'

  const textContent = `Hi ${greetingName},

We received a request to reset your password for your Snowflex account.

Click the link below to set a new password:
${resetUrl}

This link is valid for 15 minutes and can only be used once.

If you did not request this password reset, please ignore this email and your password will remain unchanged.

--
Snowflex Team`

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reset your Snowflex password</title>
  <style>
    body { margin: 0; padding: 0; background-color: #0c1612; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #d8e3dc; }
    .wrapper { width: 100%; background-color: #0c1612; padding: 40px 16px; box-sizing: border-box; }
    .container { max-width: 520px; margin: 0 auto; background-color: #14241d; border: 1px solid #233c30; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4); }
    .header { padding: 28px 32px 20px; border-bottom: 1px solid #1c3227; }
    .brand { font-size: 22px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px; }
    .brand-accent { color: #d9ed74; }
    .content { padding: 32px; font-size: 15px; line-height: 1.6; color: #cfe0d6; }
    .greeting { font-size: 18px; font-weight: 700; color: #ffffff; margin-top: 0; margin-bottom: 16px; }
    .btn-container { text-align: center; margin: 32px 0; }
    .btn { display: inline-block; background-color: #d9ed74; color: #0c1612 !important; text-decoration: none; padding: 14px 34px; border-radius: 8px; font-weight: 700; font-size: 15px; letter-spacing: 0.2px; }
    .badge { display: inline-block; background: rgba(217, 237, 116, 0.12); color: #d9ed74; border: 1px solid rgba(217, 237, 116, 0.3); border-radius: 6px; padding: 6px 14px; font-size: 13px; font-weight: 600; margin-bottom: 20px; }
    .fallback { font-size: 12px; color: #7f9488; margin-top: 30px; padding-top: 24px; border-top: 1px solid #1c3227; word-break: break-all; }
    .fallback a { color: #d9ed74; text-decoration: underline; }
    .footer { padding: 20px 32px; background-color: #0e1b15; font-size: 12px; color: #62776b; text-align: center; border-top: 1px solid #182b22; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <div class="brand">Snowflex<span class="brand-accent">.</span></div>
      </div>
      <div class="content">
        <p class="greeting">Hi ${greetingName},</p>
        <p>We received a request to reset the password for your account. You can set a new password by clicking the button below:</p>
        <div class="btn-container">
          <a href="${resetUrl}" class="btn" target="_blank" rel="noopener noreferrer">Reset Password</a>
        </div>
        <div class="badge">⏱ This link expires in <strong>15 minutes</strong></div>
        <p>If you did not request this password reset, please ignore this email and your password will remain unchanged.</p>
        <div class="fallback">
          <p>Button not working? Copy and paste this URL into your browser:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
        </div>
      </div>
      <div class="footer">
        © ${new Date().getFullYear()} Snowflex. All rights reserved.
      </div>
    </div>
  </div>
</body>
</html>`

  const transporter = createMailTransporter()

  if (!transporter) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn(`[EMAIL DEV FALLBACK] MAIL_USER not set. Dynamic reset link for ${to}:\n${resetUrl}`)
      return
    }
    throw new Error('Email service is not configured (MAIL_USER / MAIL_PASS missing in production).')
  }

  await transporter.sendMail({
    from: config.from,
    to,
    subject: 'Reset your Snowflex password',
    text: textContent,
    html: htmlContent,
  })

  logger.success(`[EMAIL] Password reset email successfully delivered to ${to}`)
}
