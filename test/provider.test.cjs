const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { createNodeRuntime } = require('../src/cli').readCore();
test(
  'Node provider transport executes a real HTTP tool turn and native child with a one-task limit',
  { timeout: 20000 },
  async (t) => {
    const http = require('node:http');
    let calls = 0;
    const provider = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      calls++;
      const last = body.messages.at(-1);
      const message =
        body.tools?.some((tool) => tool.function?.name === 'readFile') &&
        last.role !== 'tool' &&
        String(last.content).includes('read fixture')
          ? {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'file-read',
                  type: 'function',
                  function: { name: 'readFile', arguments: JSON.stringify({ path: file }) },
                },
              ],
            }
          : {
              role: 'assistant',
              content: last.role === 'tool' ? 'Read the fixture successfully' : 'Child completed',
            };
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'mock-response',
          choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 10 },
        }),
      );
    });
    await new Promise((r) => provider.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => provider.close(r)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-provider-')),
      file = path.join(dir, 'fixture.txt');
    fs.writeFileSync(file, 'fixture contents');
    const host = await createNodeRuntime({
      dataDir: path.join(dir, 'profile'),
      workspaceRoot: dir,
      settings: {
        language: 'en',
        llm: {
          provider: 'openai',
          model: 'fixture',
          apiKey: 'test-key',
          apiUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
          streamResponses: false,
        },
        decision: { enabled: false },
        automaticMemory: { enabled: false },
        sessions: { maxConcurrent: 1 },
      },
    });
    t.after(async () => {
      await host.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const session = host.runtime.createSession({ mode: 'code', workspacePath: dir });
    await host.runtime.initialize({ key: session.key });
    const result = await host.runtime.sendMessage(session.key, 'read fixture');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(calls >= 2);
    assert.ok(
      JSON.stringify(host.runtime.getSessionDetails(session.key).messages).includes(
        'Read the fixture successfully',
      ),
    );
    const parent = host.runtime.sessions.get(session.key);
    parent.busy = true;
    try {
      const child = await host.api.nativeSubagentStart(session.key, {
        task: 'Return a short finding',
        tools: ['readFile'],
        wait: true,
      });
      assert.equal(child.ok, true, JSON.stringify(child));
    } finally {
      parent.busy = false;
    }
  },
);
