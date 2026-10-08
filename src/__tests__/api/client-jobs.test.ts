import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import got from 'got';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeetCodeClient } from '../../client.js';

describe('SDK send/check HTTP contract', () => {
  let server: ReturnType<typeof createServer>;
  let client: LeetCodeClient;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let requests: { method: string; path: string; body: unknown }[];
  const request = { titleSlug: 'two-sum', questionId: '1', lang: 'golang', code: 'fixture-code' };
  beforeEach(async () => {
    requests = [];
    handler = (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    };
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({
        method: req.method!,
        path: req.url!,
        body: body ? JSON.parse(body) : undefined,
      });
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    client = new LeetCodeClient(
      'leetcode.cn',
      got.extend({ prefixUrl: `http://127.0.0.1:${port}`, retry: { limit: 2 } })
    );
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it('returns run ID before any GET, preserves test framing, and checks saved jobs separately', async () => {
    handler = (_req, res) => res.end('{"interpret_id":"run_123"}');
    const job = await client.startRun({ ...request, testcases: '[3,3]\n6' });
    expect(job).toEqual({ id: 'run_123', kind: 'run' });
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/problems/two-sum/interpret_solution/',
        body: {
          typed_code: 'fixture-code',
          lang: 'golang',
          question_id: '1',
          data_input: '[3,3]\n6',
        },
      },
    ]);
    handler = (_req, res) => res.end('{"state":"STARTED"}');
    expect(await client.checkJob(JSON.parse(JSON.stringify(job)))).toEqual({ state: 'pending' });
    expect(requests.length).toBe(2);
    expect(requests[1].method).toBe('GET');
  });
  it('submits once and the legacy wrapper returns a compile failure without success statistics', async () => {
    handler = (req, res) =>
      res.end(
        req.method === 'POST'
          ? '{"submission_id":123}'
          : '{"state":"SUCCESS","status_code":20,"status_msg":"Compile Error","compile_error":"bad code"}'
      );
    const result = await client.submitSolution('two-sum', 'bad code', 'golang', '1');
    expect(result.compile_error).toBe('bad code');
    expect(result.total_correct).toBeUndefined();
    expect(requests.map((r) => r.method)).toEqual(['POST', 'GET']);
  });
  it.each([
    { state: 'SUCCESS', status_code: 10, status_msg: 'Accepted' },
    { state: 'SUCCESS', status_code: 11, expected_output: '[0,1]', code_output: '[]' },
    { state: 'FAILURE', status_code: 20, compile_error: 'bad code' },
    { state: 'SUCCESS', status_code: 15, runtime_error: 'panic' },
    { state: 'SUCCESS', status_code: 14, status_msg: 'Time Limit Exceeded' },
  ])('preserves terminal verdict and absent statistics: $status_code', async (result) => {
    handler = (_req, res) => res.end(JSON.stringify(result));
    expect(await client.checkJob({ id: '123', kind: 'submit' })).toEqual({
      state: 'complete',
      result,
    });
    expect(requests.length).toBe(1);
  });
  it.each([
    {},
    { state: 'SUCCESS' },
    { state: 'OTHER' },
    { state: 'SUCCESS', status_code: 999 },
    { state: 'FAILURE', status_code: 10 },
  ])('rejects unrecognized responses', async (result) => {
    handler = (_req, res) => res.end(JSON.stringify(result));
    await expect(client.checkJob({ id: '123', kind: 'run' })).rejects.toMatchObject({
      kind: 'protocol',
      outcomeUnknown: false,
    });
  });
  it.each([401, 403, 429, 500])('does not replay a send after HTTP %s', async (status) => {
    handler = (_req, res) => {
      res.statusCode = status;
      res.end('secret=must-not-leak');
    };
    await expect(client.startSubmit(request)).rejects.toMatchObject({
      outcomeUnknown: status >= 500,
    });
    expect(requests.length).toBe(1);
  });
  it('does not retry checks, preserves their failure category, and never sends code', async () => {
    handler = (_req, res) => {
      res.statusCode = 500;
      res.end('secret');
    };
    await expect(client.checkJob({ id: '123', kind: 'submit' })).rejects.toMatchObject({
      kind: 'platform',
      outcomeUnknown: false,
    });
    expect(requests.map((r) => r.method)).toEqual(['GET']);
  });
  it.each(['{}', 'not json', 'null'])(
    'marks malformed send response unknown without disclosing body: %s',
    async (body) => {
      handler = (_req, res) => res.end(body);
      await expect(client.startSubmit(request)).rejects.toMatchObject({
        kind: 'protocol',
        outcomeUnknown: true,
      });
      expect(requests.length).toBe(1);
    }
  );
  it('does not follow a redirect or send to a second endpoint', async () => {
    handler = (_req, res) => {
      res.statusCode = 307;
      res.setHeader('Location', '/other');
      res.end('{}');
    };
    await expect(client.startSubmit(request)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(requests.length).toBe(1);
  });
  it('cancels before sending, and treats interruption after receipt as unknown without replay', async () => {
    const before = new AbortController();
    before.abort();
    await expect(client.startSubmit(request, { signal: before.signal })).rejects.toMatchObject({
      kind: 'cancelled',
      outcomeUnknown: false,
    });
    expect(requests.length).toBe(0);
    const during = new AbortController();
    handler = () => {
      during.abort();
    };
    const error = await client
      .startSubmit(request, { signal: during.signal })
      .catch((error) => error);
    expect(error).toMatchObject({ kind: 'network', outcomeUnknown: true });
    expect(error.cause).toBeUndefined();
    expect(requests.length).toBe(1);
  });
  it('rejects unsafe job paths without network calls', async () => {
    await expect(client.checkJob({ id: '../other', kind: 'run' })).rejects.toMatchObject({
      kind: 'protocol',
    });
    await expect(client.startSubmit({ ...request, titleSlug: '../other' })).rejects.toMatchObject({
      kind: 'protocol',
    });
    expect(requests.length).toBe(0);
  });
});
