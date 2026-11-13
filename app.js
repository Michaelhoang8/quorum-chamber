import { example, analyze, transition } from "./core.js";
const $ = (id) => document.getElementById(id),
  worker = new Worker("/worker.js", { type: "module" });
let model = example(),
  result,
  step = model.actions.length,
  ready = false,
  sequence = 0,
  undo = [];
function el(tag, text) {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}
function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
function compute() {
  ready = false;
  $("evidence").disabled = true;
  worker.postMessage({ id: ++sequence, model });
  $("editor").value = JSON.stringify(model, null, 2);
  message("Replaying messages and checking quorum safety…");
}
function change(next, nextStep = next.actions.length) {
  try {
    analyze(next);
    undo.push({ model: structuredClone(model), step });
    if (undo.length > 30) undo.shift();
    model = next;
    step = nextStep;
    compute();
  } catch (error) {
    message(error.message, true);
  }
}
function append(action) {
  if (!ready) return;
  try {
    transition(result.snapshots[step], action);
    change({ ...model, actions: [...model.actions.slice(0, step), action] });
  } catch (error) {
    message(error.message, true);
  }
}
function render() {
  if (!ready) return;
  const s = result.snapshots[step],
    majority = Math.floor(model.acceptors / 2) + 1;
  $("step").max = model.actions.length;
  $("step").value = step;
  $("position").textContent = `${step} / ${model.actions.length}`;
  $("count").value = model.acceptors;
  $("back").disabled = step === 0;
  $("next").disabled = step === model.actions.length;
  $("undo").disabled = !undo.length;
  $("event").textContent =
    s.events.at(-1)?.note ||
    "Initial state: no promises, accepted values, or messages.";
  $("chosen").textContent = s.chosen.length
    ? s.chosen[0].value
    : "No value chosen";
  $("witness").textContent = s.chosen.length
    ? s.chosen
        .map(
          (c) =>
            `Ballot ${c.ballot}: ${c.acceptors.join(" + ")} accepted ${c.value}.`,
        )
        .join(" ")
    : `Requires ${majority} distinct acceptors on one ballot/value.`;
  $("proposers").replaceChildren(
    ...["P", "Q"].map((p) => {
      const b = s.ballots.find((b) => b.ballot === s.proposers[p]);
      return el(
        "p",
        b
          ? `${p} / ballot ${b.ballot} / ${b.phase} · requested ${b.requested}${b.value !== null ? " · issued " + b.value : ""} · ${b.acks.length}/${majority} acknowledgments`
          : `${p} / no attempt`,
      );
    }),
  );
  $("acceptors").replaceChildren(
    ...s.acceptors.map((a) => {
      const card = el("div", "");
      card.className = "acceptor" + (a.online ? "" : " offline");
      card.append(
        el("h3", a.id + " · " + (a.online ? "online" : "offline")),
        el("p", "Promised ballot: " + a.promised),
        el(
          "p",
          "Accepted: " +
            (a.accepted
              ? `${a.accepted.ballot} / ${a.accepted.value}`
              : "none"),
        ),
      );
      const b = el("button", a.online ? "Crash" : "Restart");
      b.onclick = () =>
        append({ op: a.online ? "crash" : "restart", acceptor: a.id });
      card.append(b);
      return card;
    }),
  );
  $("pending").textContent = `(${s.messages.length})`;
  $("deliver-next").disabled = !s.messages.length || step >= 160;
  $("messages").replaceChildren(
    ...s.messages.map((m) => {
      const card = el("div", "");
      card.className = "mail";
      const summary = el(
          "code",
          `#${m.id} ${m.type} · ${m.from} → ${m.to}\nballot ${m.ballot}${m.value !== undefined ? " / " + m.value : ""}${m.accepted ? " / prior " + m.accepted.ballot + ":" + m.accepted.value : ""}${m.promised !== undefined ? " / promised " + m.promised : ""}`,
        ),
        buttons = el("div", "");
      for (const op of ["deliver", "drop", "duplicate"]) {
        const b = el("button", op[0].toUpperCase() + op.slice(1));
        b.disabled = step >= 160;
        b.onclick = () => append({ op, id: m.id });
        buttons.append(b);
      }
      card.append(summary, buttons);
      return card;
    }),
  );
  if (!s.messages.length)
    $("messages").append(
      el(
        "p",
        "No pending messages. Start an attempt or inspect an earlier event.",
      ),
    );
  $("ballots").replaceChildren(
    ...s.ballots.map((b) => {
      const pre = el(
        "pre",
        `Ballot ${b.ballot} / proposer ${b.proposer} / ${b.phase}\nRequested: ${b.requested} · Issued: ${b.value ?? "not yet"}\nPromise quorum: ${JSON.stringify(b.promises)}\nAcceptance acknowledgments: ${b.acks.join(", ") || "none"}\nRejections: ${JSON.stringify(b.nacks)}`,
      );
      pre.className = "ballot";
      return pre;
    }),
  );
}
worker.onmessage = ({ data }) => {
  if (data.id !== sequence) return;
  if (data.error) {
    message(data.error, true);
    return;
  }
  result = data.result;
  ready = true;
  $("evidence").disabled = false;
  step = Math.min(step, model.actions.length);
  render();
  message(
    "Every transition preserves promise ordering, value adoption, and chosen-value agreement.",
  );
};
worker.onerror = () =>
  message("Protocol worker failed. Reload to restart.", true);
$("propose").onsubmit = (e) => {
  e.preventDefault();
  append({
    op: "propose",
    proposer: $("proposer").value,
    value: $("value").value,
  });
};
$("deliver-next").onclick = () => {
  if (ready && result.snapshots[step].messages.length)
    append({ op: "deliver", id: result.snapshots[step].messages[0].id });
};
$("step").oninput = () => {
  if (!ready) return;
  step = Number($("step").value);
  render();
};
$("back").onclick = () => {
  if (!ready) return;
  step = Math.max(0, step - 1);
  render();
};
$("next").onclick = () => {
  if (!ready) return;
  step = Math.min(model.actions.length, step + 1);
  render();
};
$("example").onclick = () => change(example());
$("empty").onclick = () => change({ acceptors: model.acceptors, actions: [] });
$("count").onchange = () =>
  change({ acceptors: Number($("count").value), actions: [] });
$("undo").onclick = () => {
  if (undo.length) {
    const prior = undo.pop();
    model = prior.model;
    step = prior.step;
    compute();
  }
};
$("apply").onclick = () => {
  try {
    if ($("editor").value.length > 100000)
      throw Error("Scenario must be at most 100 KB.");
    change(JSON.parse($("editor").value));
  } catch (error) {
    message(error.message, true);
  }
};
function download(name, data) {
  const url = URL.createObjectURL(
      new Blob([data], { type: "application/json" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("save").onclick = () =>
  download(
    "quorum-chamber-scenario.json",
    JSON.stringify(model, null, 2) + "\n",
  );
$("evidence").onclick = () => {
  if (ready)
    download(
      "quorum-chamber-evidence.json",
      JSON.stringify({ ...result, inspectedStep: step }, null, 2) + "\n",
    );
};
$("open").onclick = () => $("file").click();
$("file").onchange = async () => {
  const file = $("file").files[0];
  $("file").value = "";
  if (!file) return;
  try {
    if (file.size > 100000) throw Error("Scenario must be at most 100 KB.");
    change(JSON.parse(await file.text()));
  } catch (error) {
    message(error.message, true);
  }
};
compute();
