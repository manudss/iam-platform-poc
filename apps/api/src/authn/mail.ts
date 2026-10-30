import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { MailAdapter } from './methods.js';

/** Real delivery is configured ONLY by environment variables of the server (never versioned, never in Dolt). Nothing is assumed: no sender, no provider. */
export const smtpConfigured = () => !!(process.env.IAM_SMTP_HOST && process.env.IAM_SMTP_FROM);

/** One-time codes by SMTP. The sender address and the provider are the operator's decision (IAM_SMTP_HOST, _PORT, _SECURE, _USER, _PASS, IAM_SMTP_FROM). */
export class SmtpMailAdapter implements MailAdapter {
  id = 'smtp'; real = true;
  constructor(private readonly transport: Transporter, private readonly from: string) {}
  static fromEnv(): SmtpMailAdapter | null {
    if (!smtpConfigured()) return null;
    const port = Number(process.env.IAM_SMTP_PORT ?? 587), user = process.env.IAM_SMTP_USER, pass = process.env.IAM_SMTP_PASS;
    const t = nodemailer.createTransport({ host: process.env.IAM_SMTP_HOST, port, secure: process.env.IAM_SMTP_SECURE === '1' || port === 465, requireTLS: process.env.IAM_SMTP_SECURE !== '0', ...(user && pass ? { auth: { user, pass } } : {}), connectionTimeout: 8000, socketTimeout: 10000 });
    return new SmtpMailAdapter(t, process.env.IAM_SMTP_FROM!);
  }
  async send(m: { tenant: string; to: string; subject: string; text: string; subjectUser: string }) {
    if (!/^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}$/.test(m.to)) throw new Error('invalid recipient');
    await this.transport.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
  }
}
