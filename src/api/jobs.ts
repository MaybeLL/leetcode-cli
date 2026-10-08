import type { Got } from 'got';
import { z } from 'zod';

export type ClientErrorKind =
  | 'auth'
  | 'forbidden'
  | 'throttled'
  | 'network'
  | 'protocol'
  | 'platform'
  | 'cancelled';
/** No raw HTTP error/cause is retained: these may contain credential headers. */
export class ClientError extends Error {
  constructor(
    public readonly kind: ClientErrorKind,
    message: string,
    public readonly outcomeUnknown = false
  ) {
    super(message);
    this.name = 'ClientError';
  }
}

export interface JobOptions {
  signal?: AbortSignal;
}
export interface RunRequest {
  titleSlug: string;
  code: string;
  lang: string;
  questionId: string;
  testcases: string;
}
export type SubmitRequest = Omit<RunRequest, 'testcases'>;
export interface Job {
  id: string;
  kind: 'run' | 'submit';
}
// Run IDs contain a decimal timestamp. Permit embedded dots, never path segments.
const jobIdPattern = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;

// Error verdicts often omit success-only statistics. Preserve absence, never invent them.
export const JobResultSchema = z.object({
  state: z.enum(['SUCCESS', 'FAILURE']),
  status_code: z.number().int(),
  status_msg: z.string().optional(),
  run_success: z.boolean().optional(),
  correct_answer: z.boolean().optional(),
  total_correct: z.number().optional(),
  total_testcases: z.number().optional(),
  status_runtime: z.string().optional(),
  status_memory: z.string().optional(),
  runtime_percentile: z.number().nullable().optional(),
  memory_percentile: z.number().nullable().optional(),
  code_answer: z.array(z.string()).optional(),
  expected_code_answer: z.array(z.string()).optional(),
  code_output: z.string().optional(),
  last_testcase_output: z.string().optional(),
  expected_output: z.string().optional(),
  std_output: z.string().optional(),
  std_output_list: z.array(z.string()).optional(),
  compile_error: z.string().optional(),
  full_compile_error: z.string().optional(),
  runtime_error: z.string().optional(),
  full_runtime_error: z.string().optional(),
  last_testcase: z.string().optional(),
});
export type JobResult = z.infer<typeof JobResultSchema>;
export type JobStatus = { state: 'pending' } | { state: 'complete'; result: JobResult };

export function clientError(error: unknown, mutation = false): ClientError {
  if (error instanceof ClientError) return error;
  const status = (error as { response?: { statusCode?: number } } | null)?.response?.statusCode;
  if (status === 401) return new ClientError('auth', 'Authentication required.');
  if (status === 403)
    return new ClientError('forbidden', 'Access denied; browser verification may be required.');
  if (status === 429) return new ClientError('throttled', 'Too many requests. Try later.');
  if (status && status >= 400)
    return new ClientError(
      'platform',
      `Platform request failed (HTTP ${status}).`,
      mutation && status >= 500
    );
  if ((error as { name?: string } | null)?.name === 'ParseError' || error instanceof z.ZodError)
    return new ClientError('protocol', 'Invalid platform response.', mutation);
  return new ClientError(
    'network',
    mutation ? 'Send outcome unknown; do not automatically resend.' : 'Platform connection failed.',
    mutation
  );
}

function options(signal?: AbortSignal) {
  if (signal?.aborted) throw new ClientError('cancelled', 'Cancelled before request.');
  // One call = at most one HTTP request. In particular, never replay a POST.
  return { signal, retry: { limit: 0 }, followRedirect: false, timeout: { request: 20000 } };
}

export async function startJob(
  http: Got,
  kind: Job['kind'],
  request: RunRequest | SubmitRequest,
  opts: JobOptions = {}
): Promise<Job> {
  if (!/^[a-zA-Z0-9-]+$/.test(request.titleSlug) || !request.questionId || !request.lang)
    throw new ClientError('protocol', 'Invalid problem or language.');
  const requestOptions = options(opts.signal);
  try {
    const response = await http
      .post(`problems/${request.titleSlug}/${kind === 'run' ? 'interpret_solution' : 'submit'}/`, {
        ...requestOptions,
        json: {
          lang: request.lang,
          typed_code: request.code,
          question_id: request.questionId,
          ...(kind === 'run' ? { data_input: (request as RunRequest).testcases } : {}),
        },
      })
      .json<Record<string, unknown>>();
    const id = response?.[kind === 'run' ? 'interpret_id' : 'submission_id'];
    if (
      !(
        (typeof id === 'string' && jobIdPattern.test(id)) ||
        (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
      )
    )
      throw new ClientError('protocol', 'Missing task ID; send outcome unknown.', true);
    return { id: String(id), kind };
  } catch (error) {
    throw clientError(error, true);
  }
}

export async function checkJob(http: Got, job: Job, opts: JobOptions = {}): Promise<JobStatus> {
  if (!jobIdPattern.test(job.id) || !['run', 'submit'].includes(job.kind))
    throw new ClientError('protocol', 'Invalid job.');
  const requestOptions = options(opts.signal);
  try {
    const raw = await http
      .get(`submissions/detail/${job.id}/check/`, requestOptions)
      .json<unknown>();
    const state = (raw as { state?: unknown } | null)?.state;
    if (state === 'PENDING' || state === 'STARTED') return { state: 'pending' };
    const parsed = JobResultSchema.safeParse(raw);
    if (
      !parsed.success ||
      ![10, 11, 12, 13, 14, 15, 16, 20].includes(parsed.data.status_code) ||
      (parsed.data.state === 'FAILURE' && parsed.data.status_code === 10)
    )
      throw new ClientError('protocol', 'Unrecognized judge response; no success assumed.');
    return { state: 'complete', result: parsed.data };
  } catch (error) {
    throw clientError(error);
  }
}
