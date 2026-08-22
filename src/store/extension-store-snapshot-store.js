export const BRIDGE_NAMESPACE = 'tt-extension-sync-bridge';
const SNAPSHOT_TABLE = 'snapshots';
const VALID_KEY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

function assertAdapterId(adapterId) {
  if (typeof adapterId !== 'string' || !VALID_KEY.test(adapterId)) {
    throw new TypeError(`Invalid adapter ID: ${String(adapterId)}`);
  }
}

export class ExtensionStoreSnapshotStore {
  constructor(extensionStoreApi) {
    this.api = extensionStoreApi;
  }

  async getSnapshot(adapterId) {
    assertAdapterId(adapterId);
    const result = await this.api.tryGetJson({
      namespace: BRIDGE_NAMESPACE,
      table: SNAPSHOT_TABLE,
      key: adapterId,
    });
    return result?.found ? result.value : null;
  }

  async putSnapshot(snapshot) {
    assertAdapterId(snapshot?.adapterId);
    await this.api.setJson({
      namespace: BRIDGE_NAMESPACE,
      table: SNAPSHOT_TABLE,
      key: snapshot.adapterId,
      value: snapshot,
    });
  }

  async listAdapterIds() {
    const keys = await this.api.listKeys({ namespace: BRIDGE_NAMESPACE, table: SNAPSHOT_TABLE });
    return [...keys].sort();
  }
}
