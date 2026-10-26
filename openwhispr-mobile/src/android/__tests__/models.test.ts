jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  getInfoAsync: jest.fn(),
  getFreeDiskStorageAsync: jest.fn(async () => 4_000_000_000),
  makeDirectoryAsync: jest.fn(async () => undefined),
  createDownloadResumable: jest.fn(),
  moveAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
}));
jest.mock('../../../modules/android-dictation/src', () => ({
  AndroidDictation: { sha256: jest.fn() },
}));
import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import {
  ANDROID_MODELS,
  cancelAndroidDownload,
  downloadAndroidModel,
  modelPath,
  modelReady,
  useModelDownloads,
} from '../models';
import i18n from '../strings';

const id = 'qwen-small';
const model = ANDROID_MODELS[id];
let modified = 0;
beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(FileSystem.getFreeDiskStorageAsync).mockReset().mockResolvedValue(4_000_000_000);
  jest.mocked(FileSystem.createDownloadResumable).mockReset();
  await i18n.changeLanguage('en');
  modified++;
  jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri) => ({
    exists: true,
    isDirectory: false,
    size: model.bytes,
    modificationTime: modified,
    uri,
  }));
  jest.mocked(AndroidDictation!.sha256).mockResolvedValue(model.sha256);
  jest.mocked(FileSystem.createDownloadResumable).mockReturnValue({
    downloadAsync: jest.fn(async () => ({ status: 200 })),
  } as never);
});

it('rejects same-sized corrupt weights during readiness', async () => {
  jest.mocked(AndroidDictation!.sha256).mockResolvedValue('corrupt');
  await expect(modelReady(id)).resolves.toBe(false);
});
it('reuses a checksum only while file metadata is unchanged', async () => {
  await expect(modelReady(id)).resolves.toBe(true);
  await expect(modelReady(id)).resolves.toBe(true);
  expect(AndroidDictation!.sha256).toHaveBeenCalledTimes(1);
  modified++;
  jest.mocked(AndroidDictation!.sha256).mockResolvedValue('corrupt');
  await expect(modelReady(id)).resolves.toBe(false);
});
it('repairs same-sized corrupt files and verifies their replacement', async () => {
  jest
    .mocked(AndroidDictation!.sha256)
    .mockResolvedValueOnce('corrupt')
    .mockResolvedValue(model.sha256);
  await downloadAndroidModel(id);
  expect(FileSystem.createDownloadResumable).toHaveBeenCalledTimes(1);
  expect(FileSystem.moveAsync).toHaveBeenCalledWith({
    from: `${modelPath(id)}.part`,
    to: modelPath(id),
  });
});
it('never installs a downloaded file with the wrong checksum', async () => {
  jest.mocked(AndroidDictation!.sha256).mockResolvedValue('corrupt');
  await expect(downloadAndroidModel(id)).rejects.toThrow();
  expect(FileSystem.moveAsync).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(`${modelPath(id)}.part`, {
    idempotent: true,
  });
});
it('does not require free space to reuse already verified weights', async () => {
  jest.mocked(FileSystem.getFreeDiskStorageAsync).mockResolvedValueOnce(0);
  await downloadAndroidModel(id);
  expect(FileSystem.createDownloadResumable).not.toHaveBeenCalled();
});

it('requires the current balanced artifact rather than accepting cached Qwen2.5 weights', async () => {
  jest.mocked(FileSystem.getInfoAsync).mockImplementation(async (uri) => ({
    exists: true,
    isDirectory: false,
    size: 1117320736,
    modificationTime: modified,
    uri,
  }));
  jest
    .mocked(AndroidDictation!.sha256)
    .mockResolvedValue('6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e');
  await expect(modelReady('qwen-balanced')).resolves.toBe(false);
});

it.each([
  'Software caused connection abort',
  'Connection reset',
  'Unable to resolve host "model.example.invalid": No address associated with hostname',
  'Failed to connect to model.example.invalid/192.0.2.1:443',
  'Network is unreachable',
  'Read timed out',
])('explains an interrupted download and permits retry after %s', async (message) => {
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
    exists: false,
    isDirectory: false,
    uri: modelPath(id),
  });
  jest.mocked(FileSystem.createDownloadResumable).mockReturnValueOnce({
    downloadAsync: jest.fn().mockRejectedValue(new Error(message)),
  } as never);

  await expect(downloadAndroidModel(id)).rejects.toThrow(
    'The model download was interrupted. Check your connection and try again.',
  );
  expect(useModelDownloads.getState().progress[id]).toBeUndefined();
  expect(FileSystem.moveAsync).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(`${modelPath(id)}.part`, {
    idempotent: true,
  });

  jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
    exists: false,
    isDirectory: false,
    uri: modelPath(id),
  });
  await expect(downloadAndroidModel(id)).resolves.toBeUndefined();
  expect(FileSystem.moveAsync).toHaveBeenCalledWith({
    from: `${modelPath(id)}.part`,
    to: modelPath(id),
  });
});

it('localizes an interrupted model download in Arabic', async () => {
  await i18n.changeLanguage('ar');
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
    exists: false,
    isDirectory: false,
    uri: modelPath(id),
  });
  jest.mocked(FileSystem.createDownloadResumable).mockReturnValueOnce({
    downloadAsync: jest.fn().mockRejectedValue(new Error('Software caused connection abort')),
  } as never);
  await expect(downloadAndroidModel(id)).rejects.toThrow(
    'انقطع تنزيل النموذج. تحقق من اتصالك بالإنترنت وحاول مرة أخرى.',
  );
});

it('keeps explicit cancellation separate from a resulting connection abort', async () => {
  let rejectTransfer!: (error: Error) => void;
  const transfer = new Promise<never>((_, reject) => {
    rejectTransfer = reject;
  });
  let started!: () => void;
  const downloadStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
    exists: false,
    isDirectory: false,
    uri: modelPath(id),
  });
  jest.mocked(FileSystem.createDownloadResumable).mockReturnValueOnce({
    downloadAsync: jest.fn(() => {
      started();
      return transfer;
    }),
    pauseAsync: jest.fn(async () => undefined),
  } as never);

  const downloading = downloadAndroidModel(id);
  const outcome = downloading.catch((error: Error) => error);
  await downloadStarted;
  await cancelAndroidDownload(id);
  rejectTransfer(new Error('Software caused connection abort'));
  expect(await outcome).toEqual(expect.objectContaining({ message: 'Download cancelled.' }));
  expect(useModelDownloads.getState().progress[id]).toBeUndefined();
  expect(FileSystem.moveAsync).not.toHaveBeenCalled();
});

it('does not mislabel a local storage failure as a connection interruption', async () => {
  const storageError = new Error('ENOSPC: No space left on device');
  jest.mocked(FileSystem.getInfoAsync).mockResolvedValueOnce({
    exists: false,
    isDirectory: false,
    uri: modelPath(id),
  });
  jest.mocked(FileSystem.createDownloadResumable).mockReturnValueOnce({
    downloadAsync: jest.fn().mockRejectedValue(storageError),
  } as never);
  await expect(downloadAndroidModel(id)).rejects.toBe(storageError);
  expect(useModelDownloads.getState().progress[id]).toBeUndefined();
});
