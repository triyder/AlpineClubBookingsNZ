import { z } from "zod";

export const CreatePaymentIntentSchema = z.object({
  bookingId: z.string().min(1),
});

export const CreateSetupIntentSchema = z.object({
  bookingId: z.string().min(1),
});
