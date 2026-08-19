import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { PROJECTION_KEY, registerApprovalProjection } from "../lib/projection.js";

/** Minimal projection-registry stand-in: captures the registered definition. */
function captureProjection() {
  let definition = null;
  const projectionCtx = {
    sessionProjections: {
      register: (def) => {
        definition = def;
        return () => {};
      }
    }
  };
  registerApprovalProjection((services, cb) => cb(projectionCtx));
  assert.ok(definition, "projection should be registered");
  return definition;
}

function event(type, data, time = 1000) {
  return { type, data, time, seq: 0 };
}

function captureClientPlugin() {
  let plugin = null;
  const document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {} }),
    head: { appendChild: () => {} }
  };
  const require = (name) => {
    if (name === "react") return {};
    if (name === "react/jsx-runtime") {
      return {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props })
      };
    }
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return { IconApiOutline14: () => null };
    throw new Error(`unexpected browser dependency: ${name}`);
  };
  runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), {
    window: {
      __ModuleLoader__: {
        load: ({ factory }) => {
          plugin = factory(require);
        }
      }
    },
    document,
    clearInterval,
    setInterval,
    setTimeout
  });
  assert.ok(plugin, "browser plugin should load");
  return plugin;
}

test("registers the approvalStatus projection", () => {
  const def = captureProjection();
  assert.equal(def.key, PROJECTION_KEY);
  assert.equal(typeof def.init, "function");
  assert.equal(typeof def.apply, "function");
  assert.equal(typeof def.view, "function");
  assert.equal(def.stateVersion, 1);
});

test("init yields idle state", () => {
  const def = captureProjection();
  assert.deepEqual(def.init(), { pending: null, last: null });
});

test("approval/asked folds into pending; approval/decided folds into last", () => {
  const def = captureProjection();
  let state = def.init();
  state = def.apply(state, event("approval/asked", { toolName: "pwsh", callId: "c1", reason: "escalate" }, 5000));
  assert.equal(state.pending.toolName, "pwsh");
  assert.equal(state.pending.callId, "c1");
  assert.equal(state.pending.startedAt, 5000);
  assert.equal(state.last, null);

  state = def.apply(state, event("approval/decided", { id: "x", outcome: "allowed-once" }, 9000));
  assert.equal(state.pending, null);
  assert.equal(state.last.outcome, "allowed-once");
  assert.equal(state.last.toolName, "pwsh"); // carried from pending
  assert.equal(state.last.at, 9000);
});

test("unrelated events keep the same reference (change gate)", () => {
  const def = captureProjection();
  let state = def.init();
  const next = def.apply(state, event("tool/call", { callId: "c1" }));
  assert.equal(next, state);
});

test("new asked clears last and starts a fresh pending", () => {
  const def = captureProjection();
  let state = def.init();
  state = def.apply(state, event("approval/asked", { toolName: "bash" }, 1));
  state = def.apply(state, event("approval/decided", { outcome: "rejected" }, 2));
  assert.equal(state.last.outcome, "rejected");
  state = def.apply(state, event("approval/asked", { toolName: "fs" }, 3));
  assert.equal(state.pending.toolName, "fs");
  assert.equal(state.last, null);
});

test("view passes the folded state through", () => {
  const def = captureProjection();
  const state = { pending: { toolName: "pwsh", callId: null, startedAt: 1 }, last: null };
  assert.equal(def.view(state), state);
});

test("browser plugin persists approval status in the chat flow", () => {
  const plugin = captureClientPlugin();
  let definition = null;
  let renderer = null;
  let registration = null;
  const ctx = {
    conversationEvents: {
      register: (value) => {
        definition = value;
      }
    },
    slots: {
      inject: (name, callback) => {
        assert.equal(name, "conversation.chat.node");
        callback();
      },
      register: (value, component) => {
        registration = value;
        renderer = component;
      }
    }
  };

  assert.deepEqual(Array.from(plugin.inject), ["conversationEvents", "slots"]);
  plugin.apply(ctx);
  assert.ok(definition, "conversation node definition should be registered");
  assert.ok(renderer, "chat node renderer should be registered");
  assert.deepEqual(
    { name: registration.name, key: registration.key },
    { name: "conversation.chat.node", key: "approval-status" }
  );

  const asked = event("approval/asked", { id: "approval-1", toolName: "pwsh" }, 5000);
  asked.seq = 42;
  const reviewed = event(
    "hook/result",
    {
      hook: "approve-for-me/review",
      approvalId: "approval-1",
      riskLevel: "high",
      userAuthorization: "high",
      rationale: "The user explicitly requested this narrowly scoped cleanup."
    },
    8000
  );
  const decided = event("approval/decided", { id: "approval-1", outcome: "allowed-once" }, 9000);
  assert.deepEqual(
    { ...definition.match(asked) },
    { id: "approval-1", role: "start" }
  );
  assert.deepEqual(
    { ...definition.match(decided) },
    { id: "approval-1", role: "update" }
  );
  assert.deepEqual(
    { ...definition.match(reviewed) },
    { id: "approval-1", role: "update" }
  );

  const location = { kind: "step" };
  const state = definition.start({}, { event: asked, location });
  const assessed = definition.update({ state }, { event: reviewed });
  const settled = definition.update({ state: assessed }, { event: decided });
  const node = definition.buildViewNode({
    key: "approval-status:approval-1",
    id: "approval-1",
    state: settled,
    start: { event: asked, location }
  });
  assert.equal(node.target, "chat");
  assert.equal(node.anchorSeq, 42);
  assert.equal(node.visibility, "visible");
  assert.equal(node.data.toolName, "pwsh");
  assert.equal(node.data.outcome, "allowed-once");
  assert.equal(node.data.review.rationale, "The user explicitly requested this narrowly scoped cleanup.");

  const pendingRow = renderer({ node: { data: { toolName: "pwsh", outcome: null } } });
  const pendingParts = Array.from(pendingRow.props.children);
  assert.equal(pendingRow.props.className, "afmRoot");
  assert.equal(pendingParts[0].props.className, "afmLeading");
  assert.equal(pendingParts[1].props.children, "Pwsh");
  assert.equal(pendingParts[2].props.className, "afmSep");
  assert.equal(pendingParts[3].props.className, "afmSummary afmShimmer");
  assert.equal(pendingParts[3].props.children, "正在审查权限请求");

  const approvedRow = renderer({ node: { data: { toolName: "pwsh", outcome: "allowed-once" } } });
  const approvedParts = Array.from(approvedRow.props.children);
  assert.equal(approvedParts[3].props.className, "afmSummary");
  assert.equal(approvedParts[3].props.children, "已批准权限升级");

  const reviewedRow = renderer({ node: { data: settled } });
  const reviewedParts = Array.from(reviewedRow.props.children);
  assert.equal(reviewedParts[3].props.className, "afmSummary");
  assert.equal(reviewedParts[3].props.children, "已批准权限升级 · The user explicitly requested this narrowly scoped cleanup.");

  const strictStarted = event("hook/invoked", { hook: "approve-for-me/strict-review", callId: "strict-1", toolName: "pwsh" }, 10000);
  strictStarted.seq = 77;
  const strictReviewed = event(
    "hook/result",
    {
      hook: "approve-for-me/strict-review",
      callId: "strict-1",
      toolName: "pwsh",
      outcome: "allowed",
      riskLevel: "low",
      userAuthorization: "high",
      rationale: "The requested status check is read-only."
    },
    11000
  );
  assert.deepEqual(
    { ...definition.match(strictStarted) },
    { id: "strict:strict-1", role: "start" }
  );
  assert.deepEqual(
    { ...definition.match(strictReviewed) },
    { id: "strict:strict-1", role: "update" }
  );
  const strictState = definition.start({}, { event: strictStarted, location });
  const strictSettled = definition.update({ state: strictState }, { event: strictReviewed });
  const strictNode = definition.buildViewNode({
    key: "approval-status:strict:strict-1",
    id: "strict:strict-1",
    state: strictSettled,
    start: { event: strictStarted, location }
  });
  assert.equal(strictNode.anchorSeq, 77);
  assert.equal(strictNode.data.flow, "strict");
  assert.equal(strictNode.data.outcome, "allowed");

  const strictPendingRow = renderer({ node: { data: strictState } });
  const strictPendingParts = Array.from(strictPendingRow.props.children);
  assert.equal(strictPendingParts[3].props.className, "afmSummary afmShimmer");
  assert.equal(strictPendingParts[3].props.children, "正在审查工具调用");

  const strictReviewedRow = renderer({ node: { data: strictSettled } });
  const strictReviewedParts = Array.from(strictReviewedRow.props.children);
  assert.equal(strictReviewedParts[3].props.className, "afmSummary");
  assert.equal(strictReviewedParts[3].props.children, "审查已通过 · The requested status check is read-only.");
});
