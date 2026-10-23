const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MOCKS = {
  "react-i18next": `
    export function useTranslation() {
      return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
    }
  `,
  "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: true });`,
  "/hooks/useWorkspace": `
    export const useWorkspace = () => ({
      workspaces: globalThis.__switcherState.workspaces,
      setActive() {},
      refresh: async () => {},
    });
  `,
  "/stores/workspaceStore": `
    const read = () => ({
      activeWorkspaceId: globalThis.__switcherState.activeWorkspaceId,
      loaded: true,
      loading: false,
      error: false,
      workspaces: globalThis.__switcherState.workspaces,
    });
    export const useWorkspaceStore = Object.assign((selector) => selector(read()), {
      getState: read,
    });
  `,
  "/services/WorkspacesService": `export const WorkspacesService = { listMembers: async () => [] };`,
  "/CreateWorkspaceDialog": `export default function CreateWorkspaceDialog() { return null; }`,
  // Records what the switcher hands the menu so a test can read placement and open state.
  "/ui/dropdown-menu": `
    import React from "react";
    const Pass = ({ children }) => React.createElement("div", null, children);
    export function DropdownMenu({ open, onOpenChange, children }) {
      globalThis.__menu.root = { open, onOpenChange };
      return React.createElement("div", null, children);
    }
    export function DropdownMenuTrigger({ children, ...props }) {
      return React.createElement("button", props, children);
    }
    export function DropdownMenuContent({ side, align, children }) {
      globalThis.__menu.content = { side, align };
      return React.createElement("div", null, children);
    }
    export const DropdownMenuItem = Pass;
    export const DropdownMenuSeparator = () => null;
  `,
};

async function loadSwitcher(t) {
  t.after(() => {
    delete globalThis.__menu;
    delete globalThis.__switcherState;
  });
  globalThis.__menu = {};
  globalThis.__switcherState = {
    workspaces: [{ id: "acme", name: "Acme Studio", role: "owner" }],
    activeWorkspaceId: "acme",
  };
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-switcher-placement-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { default: WorkspaceSwitcher } = await vite.ssrLoadModule(
    "/components/WorkspaceSwitcher.tsx"
  );
  return (props) => renderToStaticMarkup(createElement(WorkspaceSwitcher, props));
}

test("settings placement opens the menu below", async (t) => {
  const render = await loadSwitcher(t);

  render({ placement: "settings" });

  assert.equal(globalThis.__menu.content.side, "bottom");
  assert.equal(globalThis.__menu.content.align, "start");
});

test("sidebar placement still opens above", async (t) => {
  const render = await loadSwitcher(t);

  render({});

  assert.equal(globalThis.__menu.content.side, "top");
  assert.equal(globalThis.__menu.content.align, "start");
});

test("controlled open is passed through", async (t) => {
  const render = await loadSwitcher(t);
  const changes = [];

  render({ open: true, onOpenChange: (open) => changes.push(open) });
  assert.equal(globalThis.__menu.root.open, true);

  globalThis.__menu.root.onOpenChange(false);
  assert.deepEqual(changes, [false]);
});

test("uncontrolled leaves the menu's own state alone", async (t) => {
  const render = await loadSwitcher(t);

  render({});

  assert.equal(globalThis.__menu.root.open, undefined);
});

test("compact trigger shows only the avatar and names the workspace", async (t) => {
  const render = await loadSwitcher(t);

  const markup = render({ compact: true, placement: "settings" });

  const trigger = markup.match(/<button[^>]*>.*?<\/button>/s)[0];
  assert.match(trigger, /^<button[^>]*aria-label="Acme Studio"/);
  // The name is the label only; no visible text node in the trigger carries it.
  assert.doesNotMatch(trigger, />Acme Studio</);
  assert.match(trigger, />AS</);
});

test("the full trigger shows the workspace name", async (t) => {
  const render = await loadSwitcher(t);

  const markup = render({});

  assert.match(markup, />Acme Studio</);
});
