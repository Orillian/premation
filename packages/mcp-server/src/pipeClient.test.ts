/**
 * Where the server connects, from the files the app wrote. The pipe exchange
 * itself runs end to end in electron/mcp/bridge.test.ts.
 */

import path from 'node:path';
import { NOT_SET_UP, PremationUnavailable, readEndpoint } from './pipeClient';
import { listTools } from './server';

const files = (map: Record<string, string>) => (p: string): string => {
  const v = map[path.basename(p)];
  if (v === undefined) throw new Error('ENOENT');
  return v;
};

describe('readEndpoint', () => {
  it('reads the address and the token', () => {
    expect(readEndpoint('/d', files({ 'endpoint.json': '{"v":1,"endpoint":"\\\\\\\\.\\\\pipe\\\\p"}', token: 'abc\n' })))
      .toEqual({ endpoint: '\\\\.\\pipe\\p', token: 'abc' });
  });

  it('says "set it up in Premation" when Claude was never connected or was turned off', () => {
    const missing = (): unknown => readEndpoint('/d', files({}));
    expect(missing).toThrow(PremationUnavailable);
    expect(missing).toThrow(NOT_SET_UP);
    // Disconnect deletes the token but leaves the endpoint.
    expect(() => readEndpoint('/d', files({ 'endpoint.json': '{"endpoint":"x"}' }))).toThrow(NOT_SET_UP);
    expect(() => readEndpoint('/d', files({ 'endpoint.json': 'garbage', token: 't' }))).toThrow(NOT_SET_UP);
  });
});

describe('listTools', () => {
  it('announces the MCP surface with plain JSON schemas', () => {
    const { tools } = listTools();
    expect(tools.length).toBeGreaterThan(50);
    expect(tools.find((t) => t.name === 'author_scene')).toBeTruthy();
    expect(tools.every((t) => typeof t.description === 'string' && typeof t.inputSchema === 'object')).toBe(true);
  });
});
