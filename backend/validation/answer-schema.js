import { z } from 'zod';

/**
 * Question types supported by the Moodle AI Quick Answer
 */
export const QuestionTypeEnum = z.enum([
  'single_choice',
  'multiple_choice',
  'true_false',
  'short_answer',
  'numerical',
  'vision'
]);

/**
 * Option schema for multiple choice and true/false questions
 */
export const OptionSchema = z.object({
  id: z.string().min(1, 'Option ID is required'),
  text: z.string()
});

/**
 * Request schema for POST /api/answer
 * Supports text questions as well as vision/screenshot questions
 */
export const AnswerRequestSchema = z.object({
  platform: z.string().default('moodle'),
  questionType: z.string().default('single_choice'),
  question: z.string().default(''),
  options: z.array(OptionSchema).default([]),
  image: z.string().optional() // base64 image data URL or raw base64 string
}).refine(data => (data.question && data.question.trim().length > 0) || (data.image && data.image.length > 0), {
  message: 'Either question text or image screenshot must be provided'
});

/**
 * Validated response schema sent back to extension
 * Matches: { "answer": "...", "option": "B", "status": "success" }
 */
export const AnswerResponseSchema = z.object({
  answer: z.string().min(1, 'Answer text is required'),
  option: z.string().default(''),
  status: z.string().default('success'),
  optionIds: z.array(z.string()).default([]),
  explanation: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.90),
  needsMoreContext: z.boolean().default(false)
});

/**
 * Validate incoming request payload
 */
export function validateAnswerRequest(data) {
  return AnswerRequestSchema.safeParse(data);
}

/**
 * Validate LLM generated response payload
 */
export function validateAnswerResponse(data) {
  return AnswerResponseSchema.safeParse(data);
}
