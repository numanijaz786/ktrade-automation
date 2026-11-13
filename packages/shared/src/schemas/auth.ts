import { z } from 'zod';

/** NIST SP 800-63B: length over composition rules; 12+ chars, allow passphrases, cap to bound hashing cost. */
export const passwordSchema = z.string().min(12, 'at least 12 characters').max(128, 'at most 128 characters');
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'must be a 6-digit code');

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(80),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  totpCode: totpCodeSchema.optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const totpConfirmSchema = z.object({ code: totpCodeSchema });
export type TotpConfirmInput = z.infer<typeof totpConfirmSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export interface AuthTokensResponse {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: { id: string; email: string; displayName: string; role: 'OWNER' | 'VIEWER'; totpEnabled: boolean };
}
