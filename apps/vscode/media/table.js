// EnvSync table webview. Plain DOM; every piece of file content is set with textContent, never as
// HTML. Edits are sent to the extension with the document version they were made against.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  let model;
  const revealed = new Map();

  const ISSUE_TEXT = {
    duplicate: "Set more than once; the last assignment is used.",
    undeclared: "Not declared in envsync.config.ts.",
    "type-mismatch": "Does not match the declared type.",
    "credential-in-public": "Looks like a credential in a public (client-side) variable.",
  };

  function el(tag, attributes, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children || []) node.append(child);
    return node;
  }

  function send(edit) {
    vscode.postMessage({ type: "edit", version: model.version, edit });
  }

  function notice(text) {
    const box = document.getElementById("notice");
    if (box) {
      box.textContent = text;
      box.hidden = false;
    }
  }

  function valueCell(row) {
    const shown = row.masked ? revealed.get(row.name) : row.value;
    const cell = el("td", { class: "value" });
    if (shown === undefined) {
      cell.append(
        el("span", { class: "masked", title: row.maskReason || "", text: "\u2022\u2022\u2022\u2022\u2022\u2022" }),
        el("button", {
          class: "link",
          text: "Reveal",
          title: "Show this value here (it stays on this machine)",
          onclick: () => vscode.postMessage({ type: "reveal", version: model.version, name: row.name }),
        }),
      );
      return cell;
    }
    const input = el("input", { type: row.masked ? "password" : "text", "aria-label": `Value of ${row.name}` });
    input.value = shown;
    input.addEventListener("change", () => send({ kind: "set", name: row.name, value: input.value }));
    cell.append(input);
    if (row.masked) {
      cell.append(
        el("button", {
          class: "link",
          text: "Hide",
          onclick: () => {
            revealed.delete(row.name);
            render();
          },
        }),
      );
    }
    return cell;
  }

  function nameCell(row) {
    const input = el("input", { type: "text", class: "name", "aria-label": `Name of ${row.name}` });
    input.value = row.name;
    input.addEventListener("change", () => {
      if (input.value !== row.name) send({ kind: "rename", from: row.name, to: input.value });
    });
    return el("td", {}, [input]);
  }

  function render() {
    if (!model) return;
    app.replaceChildren();
    app.append(
      el("header", {}, [
        el("h1", { text: model.fileName }),
        el("span", { class: "environment", text: `Environment: ${model.environment}` }),
        el("button", { text: "Open as text", onclick: () => vscode.postMessage({ type: "openText" }) }),
      ]),
      el("div", { id: "notice", class: "notice", hidden: "" }),
    );
    if (!model.hasConfig) {
      app.append(el("p", { class: "hint", text: "No envsync.config.ts next to this file: types, visibility and declarations are not checked." }));
    }
    if (model.invalidLines.length > 0) {
      app.append(el("p", { class: "hint", text: `Lines not read as variables: ${model.invalidLines.join(", ")}. Edit them as text.` }));
    }

    const body = el("tbody");
    for (const row of model.rows) {
      const issues = el("td", { class: "issues" });
      for (const issue of row.issues) issues.append(el("span", { class: `issue ${issue}`, text: ISSUE_TEXT[issue] || issue }));
      body.append(
        el("tr", {}, [
          nameCell(row),
          valueCell(row),
          el("td", { text: row.visibility || "" }),
          el("td", { text: row.type || "" }),
          el("td", { text: row.required === undefined ? "" : row.required ? "yes" : "no" }),
          el("td", { class: "description", text: row.description || "" }),
          issues,
          el("td", {}, [
            el("button", {
              class: "link danger",
              text: "Remove",
              title: `Remove ${row.name} (you will see the change before it is applied)`,
              onclick: () => send({ kind: "remove", name: row.name }),
            }),
          ]),
        ]),
      );
    }
    const head = el("thead", {}, [
      el("tr", {}, ["Name", "Value", "Visibility", "Type", "Required", "Description", "Issues", ""].map((text) => el("th", { text }))),
    ]);
    app.append(el("table", {}, [head, body]));

    const newName = el("input", { type: "text", placeholder: "NEW_VARIABLE", "aria-label": "New variable name" });
    // Masked like other values: a new value is often a secret.
    const newValue = el("input", { type: "password", placeholder: "value", "aria-label": "New variable value", autocomplete: "off" });
    app.append(
      el("form", {
        class: "add",
        onsubmit: (event) => {
          event.preventDefault();
          if (newName.value.trim() !== "") send({ kind: "add", name: newName.value.trim(), value: newValue.value });
        },
      }, [newName, newValue, el("button", { type: "submit", text: "Add variable" })]),
    );
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "model") {
      model = message.model;
      // Revealed values belong to one version of the file; a new version starts hidden again.
      revealed.clear();
      render();
    } else if (message.type === "revealed") {
      revealed.set(message.name, message.value);
      render();
    } else if (message.type === "notice") {
      notice(message.text);
    }
  });

  vscode.postMessage({ type: "ready" });
})();
