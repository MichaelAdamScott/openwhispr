const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");

const WHISPER = {
  id: "custom-62aedb37-70e0-441b-b7fc-ddb651253487",
  name: "My Whisper",
  engine: "whisper",
  provider: "whisper",
  sizeBytes: 150 * 1024 * 1024,
};
const ONNX = {
  id: "custom-e65f946c-14c1-44b9-b81e-5fc217374d7e",
  name: "Bark ONNX",
  engine: "parakeet",
  provider: "nvidia",
  sizeBytes: 600 * 1024 * 1024,
};
const noop = () => {};

function findAll(node, predicate, results = []) {
  if (Array.isArray(node)) for (const child of node) findAll(child, predicate, results);
  else if (node && typeof node === "object") {
    if (predicate(node)) results.push(node);
    findAll(node.props?.children, predicate, results);
  }
  return results;
}

async function mountLibrary(t, { models = [], api = {}, props = {} } = {}) {
  let unmount = async () => {};
  t.after(() => unmount());
  const picked = [];
  const cleared = [];
  const inventories = [];
  installBrowserGlobals(t, {
    window: {
      location: { search: "" },
      dispatchEvent: () => true,
      electronAPI: {
        listCustomLocalSpeechModels: async () => ({ success: true, models }),
        ...api,
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-custom-speech-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "react-i18next": `
        const t = (key, options) => options?.defaultValue ?? key;
        export function useTranslation() { return { t }; }
      `,
    },
  });
  const { CustomLocalSpeechModels } = await vite.ssrLoadModule(
    "/components/CustomLocalSpeechModels.tsx"
  );
  let current = {
    selectedModelId: "",
    onSelect: (model) => picked.push(model),
    onClearSelection: (model) => cleared.push(model),
    onModelsChange: (inventory) => inventories.push(inventory),
    ...props,
  };
  let tree;
  function Harness() {
    tree = CustomLocalSpeechModels(current);
    return null;
  }
  const root = createRoot(container);
  const act = (fn) => React.act(async () => fn());
  const render = () => act(() => root.render(React.createElement(Harness)));
  await render();
  unmount = () => act(() => root.unmount());
  const find = (predicate) => findAll(tree, predicate);
  return {
    picked,
    cleared,
    inventories,
    find,
    setProps: async (patch) => {
      current = { ...current, ...patch };
      await render();
    },
    click: (label) => act(() => find((node) => node.props?.children === label)[0].props.onClick()),
    confirmRemoval: () =>
      act(() => find((node) => node.props?.variant === "destructive")[0].props.onConfirm()),
    select: (name) =>
      act(() =>
        find(
          (node) =>
            node.type === "button" &&
            findAll(node, (child) => child.props?.children === name).length > 0
        )[0].props.onClick()
      ),
    remove: (name) =>
      act(() => find((node) => node.props?.["aria-label"]?.includes(name))[0].props.onClick()),
    settle: act,
  };
}

test("restores imported models and selects them with keyboard-native buttons", async (t) => {
  const panel = await mountLibrary(t, {
    models: [WHISPER, ONNX],
    props: { selectedModelId: ONNX.id },
  });
  assert.equal(panel.inventories.at(-1).length, 2);
  const buttons = panel.find((node) => node.type === "button" && "aria-pressed" in node.props);
  assert.deepEqual(
    buttons.map((node) => node.props["aria-pressed"]),
    [false, true]
  );
  assert.ok(buttons.every((node) => node.props.type === "button"));
  await panel.select(WHISPER.name);
  assert.deepEqual(panel.picked, [WHISPER]);
});

test("imports the chosen runtime format, exposes validation progress and selects only on success", async (t) => {
  let finish;
  const engines = [];
  const options = [];
  const panel = await mountLibrary(t, {
    api: {
      importCustomLocalSpeechModel: (engine, configuration) => {
        engines.push(engine);
        options.push(configuration);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  await panel.click("Import Whisper .bin");
  assert.deepEqual(engines, ["whisper"]);
  assert.equal(panel.picked.length, 0);
  assert.equal(panel.find((node) => node.props?.role === "status").length, 1);
  assert.ok(
    panel
      .find(
        (node) =>
          typeof node.props?.onClick === "function" &&
          typeof node.props?.children === "string" &&
          node.props.children.startsWith("Import ")
      )
      .every((node) => node.props.disabled)
  );
  await panel.settle(() => finish({ success: true, model: WHISPER }));
  assert.deepEqual(panel.picked, [WHISPER]);
  assert.deepEqual(panel.inventories.at(-1), [WHISPER]);
  await panel.settle(() =>
    panel
      .find((node) => node.type === "input" && node.props.type === "checkbox")[0]
      .props.onChange({ target: { checked: true } })
  );
  await panel.click("Import ONNX folder");
  assert.deepEqual(engines, ["whisper", "parakeet"]);
  assert.deepEqual(options, [undefined, { leadingSilenceSeconds: 0.25 }]);
  await panel.settle(() => finish({ success: true, model: ONNX }));
  assert.deepEqual(panel.inventories.at(-1), [WHISPER, ONNX]);
  assert.deepEqual(panel.picked, [WHISPER, ONNX]);
});

test("cancel and invalid or missing-runtime errors preserve the previous selection", async (t) => {
  let response = { success: false, canceled: true };
  const panel = await mountLibrary(t, {
    models: [WHISPER],
    props: { selectedModelId: WHISPER.id },
    api: { importCustomLocalSpeechModel: async () => response },
  });
  await panel.click("Import ONNX folder");
  assert.equal(panel.picked.length, 0);
  assert.equal(panel.find((node) => node.props?.role === "alert").length, 0);
  response = {
    success: false,
    error: "The local ONNX runtime is missing. Install it before importing.",
  };
  await panel.click("Import ONNX folder");
  assert.equal(
    panel.find((node) => node.props?.role === "alert")[0].props.children,
    response.error
  );
  assert.deepEqual(panel.inventories.at(-1), [WHISPER]);
  assert.equal(panel.picked.length, 0);
});

test("successful removal clears the selected import, and failed removal preserves it", async (t) => {
  const removed = [];
  let success = false;
  const panel = await mountLibrary(t, {
    models: [WHISPER, ONNX],
    props: { selectedModelId: WHISPER.id },
    api: {
      removeCustomLocalSpeechModel: async (id) => {
        removed.push(id);
        return { success, error: "Model is in use" };
      },
    },
  });
  await panel.remove(WHISPER.name);
  assert.equal(removed.length, 0, "removal waits for its explicit app confirmation");
  await panel.confirmRemoval();
  assert.equal(panel.cleared.length, 0);
  assert.deepEqual(panel.inventories.at(-1), [WHISPER, ONNX]);
  success = true;
  await panel.remove(WHISPER.name);
  await panel.confirmRemoval();
  assert.deepEqual(panel.cleared, [WHISPER]);
  assert.deepEqual(panel.inventories.at(-1), [ONNX]);
});

test("live meeting picker does not import or list offline custom models", async (t) => {
  let lists = 0;
  const panel = await mountLibrary(t, {
    props: { streamingOnly: true },
    api: {
      listCustomLocalSpeechModels: async () => {
        lists++;
        return { success: true, models: [WHISPER] };
      },
    },
  });
  assert.equal(lists, 0);
  assert.equal(panel.find((node) => typeof node.props?.onClick === "function").length, 0);
  assert.equal(
    panel.find(
      (node) =>
        typeof node.props?.children === "string" &&
        node.props.children.includes("live meeting transcription")
    ).length,
    1
  );
});

test("picker routes custom selections and clears them through the same provider/model callbacks", async (t) => {
  const selections = [];
  const providers = [];
  const panel = await mountSettingsPanel(t, {
    module: "/components/TranscriptionModelPicker.tsx",
    props: {
      selectedCloudProvider: "openai",
      selectedCloudModel: "whisper-1",
      selectedLocalProvider: "whisper",
      selectedLocalModel: WHISPER.id,
      useLocalWhisper: true,
      mode: "local",
      onCloudProviderSelect: noop,
      onCloudModelSelect: noop,
      onLocalModelSelect: (...selection) => selections.push(selection),
      onLocalProviderSelect: (provider) => providers.push(provider),
      onModeChange: noop,
    },
    electronAPI: {
      onWhisperDownloadProgress: () => noop,
      onParakeetDownloadProgress: () => noop,
      listWhisperModels: async () => ({
        success: true,
        models: [
          { model: "tiny", downloaded: true },
          { model: WHISPER.id, downloaded: false },
        ],
      }),
      listParakeetModels: async () => ({ success: true, models: [] }),
    },
  });
  assert.deepEqual(selections, [], "the built-in list must not replace a persisted imported id");
  assert.equal(
    panel.find((node) => node.props?.modelId === WHISPER.id).length,
    0,
    "imports appear only in their own library"
  );
  const library = () => panel.find((node) => "onClearSelection" in (node.props ?? {}))[0];
  await React.act(async () => library().props.onSelect(ONNX));
  assert.deepEqual(providers, ["nvidia"]);
  assert.deepEqual(selections, [[ONNX.id, "nvidia"]]);
  await panel.setProps({ selectedLocalProvider: "nvidia", selectedLocalModel: ONNX.id });
  await panel.selectTab("whisper");
  assert.deepEqual(
    selections,
    [[ONNX.id, "nvidia"]],
    "browsing built-ins preserves an imported selection"
  );
  await React.act(async () => library().props.onClearSelection(ONNX));
  assert.deepEqual(selections.at(-1), ["", "nvidia"]);
});
