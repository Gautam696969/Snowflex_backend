export class PresenceManager {
  private userSockets = new Map<number, Set<string>>()
  private lastSeenMap = new Map<number, Date>()

  addConnection(userId: number, socketId: string): { wasOffline: boolean } {
    const sockets = this.userSockets.get(userId) || new Set<string>()
    const wasOffline = sockets.size === 0
    sockets.add(socketId)
    this.userSockets.set(userId, sockets)
    return { wasOffline }
  }

  removeConnection(userId: number, socketId: string): { isNowOffline: boolean; lastSeen: Date } {
    const sockets = this.userSockets.get(userId)
    if (!sockets) {
      const now = new Date()
      this.lastSeenMap.set(userId, now)
      return { isNowOffline: true, lastSeen: now }
    }

    sockets.delete(socketId)
    if (sockets.size === 0) {
      this.userSockets.delete(userId)
      const now = new Date()
      this.lastSeenMap.set(userId, now)
      return { isNowOffline: true, lastSeen: now }
    }

    return { isNowOffline: false, lastSeen: new Date() }
  }

  isOnline(userId: number): boolean {
    const sockets = this.userSockets.get(userId)
    return Boolean(sockets && sockets.size > 0)
  }

  getLastSeen(userId: number): string | null {
    const lastSeen = this.lastSeenMap.get(userId)
    return lastSeen ? lastSeen.toISOString() : null
  }

  getOnlineUserIds(): number[] {
    return Array.from(this.userSockets.keys())
  }

  clear(): void {
    this.userSockets.clear()
    this.lastSeenMap.clear()
  }
}

export const presenceManager = new PresenceManager()
