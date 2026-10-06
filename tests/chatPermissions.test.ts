import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  canChat,
  getChatPermissionMatrix,
  getAllowedChatRoles,
  ChatRole,
} from '../src/config/chatPermissions'

describe('Chat Permissions Matrix & canChat helper', () => {
  const allRoles: ChatRole[] = ['SUPER_ADMIN', 'ADMIN', 'HR', 'MANAGER', 'EMPLOYEE']

  it('verifies symmetry: canChat(roleA, roleB) === canChat(roleB, roleA) for all 25 role pairs', () => {
    for (const rA of allRoles) {
      for (const rB of allRoles) {
        expect(canChat(rA, rB)).toBe(canChat(rB, rA))
      }
    }
  })

  describe('Default configuration (ALLOW_ADMIN_TO_ADMIN_CHAT = false)', () => {
    it('EMPLOYEE can ONLY chat with ADMIN', () => {
      expect(canChat('EMPLOYEE', 'ADMIN')).toBe(true)
      expect(canChat('ADMIN', 'EMPLOYEE')).toBe(true)

      expect(canChat('EMPLOYEE', 'EMPLOYEE')).toBe(false)
      expect(canChat('EMPLOYEE', 'MANAGER')).toBe(false)
      expect(canChat('EMPLOYEE', 'HR')).toBe(false)
      expect(canChat('EMPLOYEE', 'SUPER_ADMIN')).toBe(false)
    })

    it('ADMIN can chat with EMPLOYEE, MANAGER, HR, SUPER_ADMIN but NOT another ADMIN by default', () => {
      expect(canChat('ADMIN', 'EMPLOYEE')).toBe(true)
      expect(canChat('ADMIN', 'MANAGER')).toBe(true)
      expect(canChat('ADMIN', 'HR')).toBe(true)
      expect(canChat('ADMIN', 'SUPER_ADMIN')).toBe(true)
      expect(canChat('ADMIN', 'ADMIN')).toBe(false)
    })

    it('MANAGER can chat with ADMIN, other MANAGERs, HR, SUPER_ADMIN but NOT EMPLOYEE', () => {
      expect(canChat('MANAGER', 'ADMIN')).toBe(true)
      expect(canChat('MANAGER', 'MANAGER')).toBe(true)
      expect(canChat('MANAGER', 'HR')).toBe(true)
      expect(canChat('MANAGER', 'SUPER_ADMIN')).toBe(true)
      expect(canChat('MANAGER', 'EMPLOYEE')).toBe(false)
    })

    it('HR can chat with ADMIN, MANAGER, other HRs, SUPER_ADMIN but NOT EMPLOYEE', () => {
      expect(canChat('HR', 'ADMIN')).toBe(true)
      expect(canChat('HR', 'MANAGER')).toBe(true)
      expect(canChat('HR', 'HR')).toBe(true)
      expect(canChat('HR', 'SUPER_ADMIN')).toBe(true)
      expect(canChat('HR', 'EMPLOYEE')).toBe(false)
    })

    it('SUPER_ADMIN can chat with ADMIN, MANAGER, HR, other SUPER_ADMINs but NOT EMPLOYEE', () => {
      expect(canChat('SUPER_ADMIN', 'ADMIN')).toBe(true)
      expect(canChat('SUPER_ADMIN', 'MANAGER')).toBe(true)
      expect(canChat('SUPER_ADMIN', 'HR')).toBe(true)
      expect(canChat('SUPER_ADMIN', 'SUPER_ADMIN')).toBe(true)
      expect(canChat('SUPER_ADMIN', 'EMPLOYEE')).toBe(false)
    })
  })

  describe('When allowAdminToAdminChat is enabled', () => {
    it('allows ADMIN to chat with ADMIN when override option is true', () => {
      expect(canChat('ADMIN', 'ADMIN', { allowAdminToAdminChat: true })).toBe(true)
    })

    it('allows ADMIN to chat with ADMIN when ALLOW_ADMIN_TO_ADMIN_CHAT env is "true"', () => {
      const original = process.env.ALLOW_ADMIN_TO_ADMIN_CHAT
      process.env.ALLOW_ADMIN_TO_ADMIN_CHAT = 'true'
      expect(canChat('ADMIN', 'ADMIN')).toBe(true)
      process.env.ALLOW_ADMIN_TO_ADMIN_CHAT = original
    })
  })

  describe('Role normalization and edge cases', () => {
    it('handles legacy "USER" by normalizing to EMPLOYEE', () => {
      expect(canChat('USER', 'ADMIN')).toBe(true)
      expect(canChat('USER', 'MANAGER')).toBe(false)
    })

    it('handles lowercase, leading/trailing whitespace, and hyphens', () => {
      expect(canChat('  employee  ', 'admin')).toBe(true)
      expect(canChat('super-admin', 'manager')).toBe(true)
    })

    it('returns false for null or undefined roles', () => {
      expect(canChat(null, 'ADMIN')).toBe(false)
      expect(canChat('ADMIN', undefined)).toBe(false)
      expect(canChat(null, null)).toBe(false)
    })
  })

  describe('getAllowedChatRoles helper', () => {
    it('returns exact allowed target list for each role', () => {
      expect(getAllowedChatRoles('EMPLOYEE')).toEqual(['ADMIN'])
      expect(getAllowedChatRoles('ADMIN').sort()).toEqual(['EMPLOYEE', 'HR', 'MANAGER', 'SUPER_ADMIN'].sort())
      expect(getAllowedChatRoles('MANAGER').sort()).toEqual(['ADMIN', 'HR', 'MANAGER', 'SUPER_ADMIN'].sort())
      expect(getAllowedChatRoles('HR').sort()).toEqual(['ADMIN', 'HR', 'MANAGER', 'SUPER_ADMIN'].sort())
      expect(getAllowedChatRoles('SUPER_ADMIN').sort()).toEqual(['ADMIN', 'HR', 'MANAGER', 'SUPER_ADMIN'].sort())
    })
  })
})
