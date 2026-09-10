/** Minimal Node.js adapter for AgentCodeGUI External Tools API v1.
 * No dependencies. Credentials stay inside this native process.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const clone = value => JSON.parse(JSON.stringify(value))

export class ExternalToolClient extends EventEmitter {
  constructor(manifest, { appHome = process.env.CCG_HOME || path.join(os.homedir(), '.agentcodegui3') } = {}) {
    super()
    if (!manifest.id || !manifest.instanceId || !manifest.name) throw new Error('id, name and stable instanceId are required')
    this.manifest = clone(manifest)
    this.appHome = path.resolve(appHome)
    this.discoveryPath = path.join(this.appHome, 'external-bridge.json')
    this.credentials = null
    this.discovery = null
    this.desired = { items: [], state: null }
    this.desiredVersion = 1
    this.sentVersion = 0
    this.revision = 0
    this.manifestVersion = 1
    this.sentManifestVersion = 0
    this.icons = []
    this.status = { connected: false, bindings: [], boundChatId: null, enabled: false, revision: 0, error: '' }
    this.running = false
    this.flight = null
  }

  async readDiscovery() {
    const discovery = JSON.parse(await fs.readFile(this.discoveryPath, 'utf8'))
    const url = new URL(discovery.url)
    if (discovery.protocolVersion !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || typeof discovery.token !== 'string' || !discovery.token) {
      throw new Error('Invalid local AgentCodeGUI discovery file')
    }
    return discovery
  }

  async request(endpoint, { method = 'GET', body, bootstrap = false } = {}) {
    const token = bootstrap ? this.discovery.token : this.credentials.token
    const response = await fetch(this.discovery.url + endpoint, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000)
    })
    const data = await response.json()
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `HTTP ${response.status}`)
      error.status = response.status
      throw error
    }
    return data
  }

  updateStatus(patch) {
    const next = { ...this.status, ...patch }
    if (JSON.stringify(next) !== JSON.stringify(this.status)) { this.status = next; this.emit('status', clone(next)) }
  }

  start() {
    if (this.running) return this
    this.running = true
    this.loop = this.run()
    return this
  }

  async run() {
    while (this.running) {
      try {
        const current = await this.readDiscovery()
        if (this.discovery?.url !== current.url || this.discovery?.token !== current.token) {
          this.credentials = null
          this.sentVersion = 0
          this.revision = 0
        }
        this.discovery = current
        if (!this.credentials) {
          this.credentials = await this.request('/v1/connect', { method: 'POST', bootstrap: true, body: { protocolVersion: 1, manifest: this.manifest } })
          this.revision = 0
          this.sentVersion = 0
          this.sentManifestVersion = this.manifestVersion
          this.icons = (await this.request('/v1/icons', { bootstrap: true })).icons
          this.emit('icons', this.icons)
        }
        await this.flush()
        const status = await this.request(`/v1/clients/${this.credentials.clientId}/poll`)
        const bindings = status.bindings ?? (status.boundChatId ? [{ chatId: status.boundChatId, enabled: status.enabled, includeSelection: true }] : [])
        this.updateStatus({ connected: true, bindings, boundChatId: status.boundChatId, enabled: bindings.some(b => b.enabled), revision: status.revision, error: '' })
      } catch (error) {
        if (error.status === 401) this.credentials = null
        this.updateStatus({ connected: false, error: error.code === 'ENOENT' ? 'AgentCodeGUI 실행을 기다리는 중' : error.message })
      }
      if (this.running) await sleep(650)
    }
  }

  /** Latest-value publishing: fast selections coalesce while offline/in flight. */
  async publish(document) {
    const encoded = JSON.stringify(document)
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new Error('Document exceeds 256 KiB')
    this.desired = JSON.parse(encoded)
    this.desiredVersion++
    if (this.credentials) await this.flush()
  }

  async updateManifest(patch) {
    this.manifest = { ...this.manifest, ...clone(patch), id: this.manifest.id, instanceId: this.manifest.instanceId }
    this.manifestVersion++
    if (this.credentials) await this.flush()
  }

  async flush() {
    if (this.flight) return this.flight
    this.flight = (async () => {
      while (this.credentials && (this.sentVersion < this.desiredVersion || this.sentManifestVersion < this.manifestVersion)) {
        const clientId = this.credentials.clientId
        if (this.sentManifestVersion < this.manifestVersion) {
          const version = this.manifestVersion
          await this.request(`/v1/clients/${clientId}/manifest`, { method: 'POST', body: { manifest: this.manifest } })
          this.sentManifestVersion = version
        }
        if (this.sentVersion < this.desiredVersion) {
          const version = this.desiredVersion
          const revision = ++this.revision
          await this.request(`/v1/clients/${clientId}/publish`, { method: 'POST', body: { revision, document: this.desired } })
          this.sentVersion = version
          this.emit('published', { revision, version })
        }
      }
    })().finally(() => { this.flight = null })
    return this.flight
  }

  async close() {
    this.running = false
    await this.loop?.catch(() => {})
    if (this.credentials) await this.request(`/v1/clients/${this.credentials.clientId}`, { method: 'DELETE' }).catch(() => {})
    this.credentials = null
    this.updateStatus({ connected: false, error: '' })
  }
}
