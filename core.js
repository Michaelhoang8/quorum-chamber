export function initial(count = 3) {
  if (![3, 5].includes(count)) throw Error("Use three or five acceptors.");
  return {
    acceptors: Array.from({ length: count }, (_, i) => ({
      id: "A" + (i + 1),
      online: true,
      promised: 0,
      accepted: null,
    })),
    proposers: { P: 0, Q: 0 },
    ballots: [],
    messages: [],
    nextMessage: 1,
    nextBallot: 1,
    votes: [],
    chosen: [],
    events: [],
  };
}
function send(s, message) {
  if (s.messages.length >= 60)
    throw Error("Pending-message limit is 60. Deliver or drop messages first.");
  s.messages.push({ id: s.nextMessage++, ...structuredClone(message) });
}
function votes(s) {
  const byBallot = new Map();
  for (const vote of s.votes) {
    if (!byBallot.has(vote.ballot))
      byBallot.set(vote.ballot, { value: vote.value, acceptors: [] });
    const entry = byBallot.get(vote.ballot);
    if (entry.value !== vote.value)
      throw Error("Safety invariant: a ballot has multiple values.");
    if (!entry.acceptors.includes(vote.acceptor))
      entry.acceptors.push(vote.acceptor);
  }
  for (const [ballot, vote] of byBallot)
    if (
      vote.acceptors.length > s.acceptors.length / 2 &&
      !s.chosen.some((c) => c.ballot === ballot)
    )
      s.chosen.push({ ballot, ...vote });
  if (new Set(s.chosen.map((c) => c.value)).size > 1)
    throw Error("Safety invariant: conflicting chosen values.");
}
export function check(s) {
  votes(s);
  for (const a of s.acceptors) {
    if (a.accepted && a.accepted.ballot > a.promised)
      throw Error("Promise invariant failed.");
  }
  for (const b of s.ballots)
    if (b.phase === "accept" || b.phase === "learned") {
      if (Object.keys(b.promises).length <= s.acceptors.length / 2)
        throw Error("Accept phase lacks a promise quorum.");
      const accepted = Object.values(b.promises)
        .filter(Boolean)
        .sort((a, b) => b.ballot - a.ballot);
      if (b.value !== (accepted.length ? accepted[0].value : b.requested))
        throw Error("Highest-accepted-value adoption invariant failed.");
    }
  return true;
}
export function transition(state, action) {
  const s = structuredClone(state);
  if (s.events.length >= 160) throw Error("Scenario limit is 160 actions.");
  if (!action || typeof action !== "object") throw Error("Invalid action.");
  let note = "";
  const keys = Object.keys(action).sort().join(",");
  if (action.op === "propose") {
    if (
      keys !== "op,proposer,value" ||
      !["P", "Q"].includes(action.proposer) ||
      typeof action.value !== "string" ||
      !action.value.length ||
      action.value.length > 40 ||
      !/^[\x20-\x7e]+$/.test(action.value)
    )
      throw Error("Proposal needs P or Q and 1–40 printable ASCII characters.");
    const ballot = s.nextBallot++,
      b = {
        ballot,
        proposer: action.proposer,
        requested: action.value,
        value: null,
        phase: "prepare",
        promises: {},
        acks: [],
        nacks: [],
      };
    s.ballots.push(b);
    s.proposers[action.proposer] = ballot;
    for (const a of s.acceptors)
      send(s, { type: "prepare", from: action.proposer, to: a.id, ballot });
    note = `${action.proposer} opened ballot ${ballot} for ${action.value}.`;
  } else if (action.op === "crash" || action.op === "restart") {
    if (keys !== "acceptor,op") throw Error("Use an acceptor ID.");
    const a = s.acceptors.find((a) => a.id === action.acceptor);
    if (!a) throw Error("Unknown acceptor.");
    a.online = action.op === "restart";
    note = `${a.id} ${a.online ? "restarted" : "crashed"}; promised and accepted state retained.`;
  } else if (["deliver", "drop", "duplicate"].includes(action.op)) {
    if (keys !== "id,op" || !Number.isInteger(action.id))
      throw Error("Use a pending message ID.");
    const i = s.messages.findIndex((m) => m.id === action.id);
    if (i < 0) throw Error("Message is no longer pending.");
    const m = s.messages[i];
    if (action.op === "duplicate") {
      const { id, ...copy } = m;
      send(s, copy);
      note = `Duplicated message ${id}.`;
    } else {
      s.messages.splice(i, 1);
      if (action.op === "drop") note = `Dropped message ${m.id}.`;
      else if (m.to.startsWith("A")) {
        const a = s.acceptors.find((a) => a.id === m.to);
        if (!a.online) note = `Message ${m.id} lost: ${a.id} is offline.`;
        else if (m.ballot < a.promised) {
          send(s, {
            type: "nack",
            from: a.id,
            to: m.from,
            ballot: m.ballot,
            promised: a.promised,
          });
          note = `${a.id} rejected ballot ${m.ballot}; promised ${a.promised}.`;
        } else if (m.type === "prepare") {
          a.promised = m.ballot;
          send(s, {
            type: "promise",
            from: a.id,
            to: m.from,
            ballot: m.ballot,
            accepted: a.accepted,
          });
          note = `${a.id} promised ballot ${m.ballot}.`;
        } else if (m.type === "accept") {
          a.promised = m.ballot;
          a.accepted = { ballot: m.ballot, value: m.value };
          if (
            !s.votes.some((v) => v.ballot === m.ballot && v.acceptor === a.id)
          )
            s.votes.push({ ballot: m.ballot, value: m.value, acceptor: a.id });
          send(s, {
            type: "accepted",
            from: a.id,
            to: m.from,
            ballot: m.ballot,
            value: m.value,
          });
          note = `${a.id} accepted ${m.value} in ballot ${m.ballot}.`;
        } else throw Error("Unexpected acceptor message.");
      } else {
        const b = s.ballots.find((b) => b.ballot === m.ballot);
        if (!b || s.proposers[m.to] !== m.ballot)
          note = `Ignored stale response for ballot ${m.ballot}.`;
        else if (m.type === "nack") {
          b.nacks.push({ acceptor: m.from, promised: m.promised });
          note = `${b.proposer} learned of promise ${m.promised}; a new attempt is manual.`;
        } else if (m.type === "promise") {
          if (b.phase !== "prepare")
            note = `Ignored late promise for ballot ${b.ballot}.`;
          else {
            b.promises[m.from] = m.accepted;
            note = `${b.proposer} received ${Object.keys(b.promises).length} distinct promises.`;
            if (Object.keys(b.promises).length > s.acceptors.length / 2) {
              const prior = Object.values(b.promises)
                .filter(Boolean)
                .sort((a, b) => b.ballot - a.ballot);
              b.value = prior.length ? prior[0].value : b.requested;
              b.phase = "accept";
              for (const a of s.acceptors)
                send(s, {
                  type: "accept",
                  from: b.proposer,
                  to: a.id,
                  ballot: b.ballot,
                  value: b.value,
                });
              note += ` Quorum reached; phase two carries ${b.value}.`;
            }
          }
        } else if (m.type === "accepted") {
          if (m.value !== b.value)
            throw Error("Accepted response disagrees with issued value.");
          if (!b.acks.includes(m.from)) b.acks.push(m.from);
          if (b.acks.length > s.acceptors.length / 2) b.phase = "learned";
          note = `${b.proposer} received ${b.acks.length} distinct acceptance acknowledgments.`;
        } else throw Error("Unexpected proposer message.");
      }
    }
  } else throw Error("Unknown operation.");
  s.events.push({
    index: s.events.length + 1,
    action: structuredClone(action),
    note,
  });
  check(s);
  return s;
}
export function analyze(model) {
  if (
    !model ||
    Object.keys(model).sort().join(",") !== "acceptors,actions" ||
    !Array.isArray(model.actions) ||
    model.actions.length > 160
  )
    throw Error("Use acceptors and an actions array (at most 160).");
  let state = initial(model.acceptors);
  const snapshots = [state];
  for (const a of model.actions) {
    state = transition(state, a);
    snapshots.push(state);
  }
  return {
    format: "quorum-chamber-evidence-v1",
    model: structuredClone(model),
    snapshots,
    final: state,
  };
}
export function example() {
  const actions = [];
  let s = initial();
  function apply(a) {
    actions.push(a);
    s = transition(s, a);
  }
  function deliver(type, from, to) {
    const m = s.messages.find(
      (m) => m.type === type && m.from === from && m.to === to,
    );
    if (!m) throw Error("Example missing message.");
    apply({ op: "deliver", id: m.id });
  }
  apply({ op: "propose", proposer: "P", value: "amber" });
  for (const a of ["A1", "A2"]) deliver("prepare", "P", a);
  for (const a of ["A1", "A2"]) deliver("promise", a, "P");
  for (const a of ["A1", "A2"]) deliver("accept", "P", a);
  for (const a of ["A1", "A2"]) deliver("accepted", a, "P");
  apply({ op: "propose", proposer: "Q", value: "indigo" });
  for (const a of ["A2", "A3"]) deliver("prepare", "Q", a);
  for (const a of ["A2", "A3"]) deliver("promise", a, "Q");
  for (const a of ["A2", "A3"]) deliver("accept", "Q", a);
  for (const a of ["A2", "A3"]) deliver("accepted", a, "Q");
  return { acceptors: 3, actions };
}
