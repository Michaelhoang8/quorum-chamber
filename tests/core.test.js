import test from "node:test";
import assert from "node:assert/strict";
import { initial, transition, analyze, example, check } from "../core.js";
function deliver(s, predicate) {
  const m = s.messages.find(predicate);
  assert.ok(m);
  return transition(s, { op: "deliver", id: m.id });
}
test("later quorum adopts a chosen value instead of its own request", () => {
  const r = analyze(example());
  assert.equal(r.final.ballots[1].requested, "indigo");
  assert.equal(r.final.ballots[1].value, "amber");
  assert.deepEqual(
    r.final.chosen.map((c) => c.value),
    ["amber", "amber"],
  );
  assert.equal(r.final.ballots[1].phase, "learned");
  const chosenBeforeLearn = r.snapshots.find(
    (s) => s.chosen.length && s.ballots[0].phase !== "learned",
  );
  assert.ok(chosenBeforeLearn);
});
test("duplicates do not create a quorum and crashes preserve acceptor promises", () => {
  let s = transition(initial(), { op: "propose", proposer: "P", value: "one" });
  s = deliver(s, (m) => m.to === "A1");
  const promise = s.messages.find((m) => m.type === "promise");
  s = transition(s, { op: "duplicate", id: promise.id });
  s = deliver(s, (m) => m.id === promise.id);
  s = deliver(s, (m) => m.type === "promise");
  assert.equal(Object.keys(s.ballots[0].promises).length, 1);
  assert.equal(s.ballots[0].phase, "prepare");
  s = transition(s, { op: "crash", acceptor: "A1" });
  s = transition(s, { op: "restart", acceptor: "A1" });
  assert.equal(s.acceptors[0].promised, 1);
});
test("higher promises reject stale accept messages after restart", () => {
  let s = analyze(example()).final;
  const before = structuredClone(s.acceptors[1]);
  s = transition(s, { op: "crash", acceptor: "A2" });
  s = transition(s, { op: "restart", acceptor: "A2" });
  assert.deepEqual(s.acceptors[1], before);
  const old = s.messages.find(
    (m) => m.type === "accept" && m.ballot === 1 && m.to === "A3",
  );
  s = transition(s, { op: "deliver", id: old.id });
  assert.ok(
    s.messages.some(
      (m) => m.type === "nack" && m.ballot === 1 && m.promised === 2,
    ),
  );
  assert.equal(s.acceptors[2].accepted.ballot, 2);
});
test("delivery to offline acceptor is lost and does not erase persisted state", () => {
  let s = transition(initial(), { op: "propose", proposer: "P", value: "one" });
  s = transition(s, { op: "crash", acceptor: "A1" });
  s = deliver(s, (m) => m.to === "A1");
  assert.equal(s.acceptors[0].promised, 0);
  assert.equal(s.messages.length, 2);
  assert.ok(s.events.at(-1).note.includes("offline"));
});
test("500 adversarial schedules preserve safety and monotonically durable promises", () => {
  let seed = 73;
  const rnd = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  for (let run = 0; run < 500; run++) {
    let s = initial(run % 2 ? 3 : 5);
    for (let i = 0; i < 100; i++) {
      let a;
      const kind = rnd(10);
      if (kind < 2)
        a = {
          op: "propose",
          proposer: rnd(2) ? "P" : "Q",
          value: "value" + rnd(4),
        };
      else if (kind === 2)
        a = {
          op: rnd(2) ? "crash" : "restart",
          acceptor: s.acceptors[rnd(s.acceptors.length)].id,
        };
      else if (s.messages.length)
        a = {
          op: kind === 3 ? "drop" : kind === 4 ? "duplicate" : "deliver",
          id: s.messages[rnd(s.messages.length)].id,
        };
      else continue;
      let next;
      try {
        next = transition(s, a);
      } catch (error) {
        assert.match(error.message, /Pending-message limit/);
        continue;
      }
      for (let j = 0; j < s.acceptors.length; j++)
        assert.ok(next.acceptors[j].promised >= s.acceptors[j].promised);
      s = next;
      check(s);
      const chosenByVotes = new Map();
      for (const vote of s.votes) {
        if (!chosenByVotes.has(vote.ballot))
          chosenByVotes.set(vote.ballot, {
            value: vote.value,
            voters: new Set(),
          });
        const b = chosenByVotes.get(vote.ballot);
        assert.equal(b.value, vote.value);
        b.voters.add(vote.acceptor);
      }
      const values = [...chosenByVotes.values()]
        .filter((b) => b.voters.size > s.acceptors.length / 2)
        .map((b) => b.value);
      assert.ok(new Set(values).size <= 1);
    }
  }
});
test("failed transitions are atomic and bounds reject invalid scenarios", () => {
  const s = initial(),
    copy = structuredClone(s);
  assert.throws(() => transition(s, { op: "deliver", id: 999 }));
  assert.deepEqual(s, copy);
  assert.throws(() => initial(4));
  assert.throws(() =>
    transition(s, { op: "propose", proposer: "P", value: "\n" }),
  );
  assert.throws(() => analyze({ acceptors: 3, actions: [], extra: 1 }));
});
