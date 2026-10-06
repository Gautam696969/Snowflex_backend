import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app'
import { createToken } from '../src/utils/jwt'
import { userService, UserProfileData } from '../src/services/user.service'

process.env.JWT_SECRET = 'test-only-secret-with-sufficient-entropy'

const mockProfile: UserProfileData = {
  id: 1,
  fullName: 'John Doe',
  email: 'john@example.com',
  role: 'EMPLOYEE',
  avatarUrl: null,
  hasPassword: true,
  employeeId: 10,
  employeeCode: 'EMP-000001',
  phone: '+1 555-0100',
  departmentId: 1,
  departmentName: 'Engineering',
  designation: 'Software Engineer',
  joiningDate: '2024-01-01',
  status: 'ACTIVE',
  address: '123 Main St',
  dateOfBirth: '1995-05-15',
  gender: 'Male',
  createdAt: '2024-01-01T00:00:00Z',
}

describe('user profile endpoints', () => {
  const app = createApp()
  const employeeToken = createToken({ id: 1, email: 'john@example.com', role: 'EMPLOYEE' })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('GET /api/users/me requires authentication', async () => {
    await request(app).get('/api/users/me').expect(401)
  })

  it('GET /api/users/me returns authenticated user profile', async () => {
    vi.spyOn(userService, 'getProfile').mockResolvedValueOnce(mockProfile)

    const response = await request(app)
      .get('/api/users/me')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200)

    expect(response.body).toEqual({
      success: true,
      message: 'Profile retrieved successfully',
      data: mockProfile,
    })
  })

  it('PUT /api/users/me updates profile fields', async () => {
    const updated = { ...mockProfile, fullName: 'John Updated', phone: '+1 555-9999' }
    vi.spyOn(userService, 'updateProfile').mockResolvedValueOnce(updated)

    const response = await request(app)
      .put('/api/users/me')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ fullName: 'John Updated', phone: '+1 555-9999' })
      .expect(200)

    expect(response.body).toEqual({
      success: true,
      message: 'Profile updated successfully',
      data: updated,
    })
  })

  it('PUT /api/users/me validates fullName minimum length', async () => {
    await request(app)
      .put('/api/users/me')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ fullName: 'A' })
      .expect(400)
  })

  it('POST /api/users/me/avatar rejects uploads without a file', async () => {
    await request(app)
      .post('/api/users/me/avatar')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(400)
  })

  it('POST /api/users/me/avatar accepts a valid image and updates avatar', async () => {
    vi.spyOn(userService, 'updateAvatar').mockResolvedValueOnce('/uploads/avatars/test-avatar.png')

    // Valid 8-byte PNG header buffer
    const pngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00])

    const response = await request(app)
      .post('/api/users/me/avatar')
      .set('Authorization', `Bearer ${employeeToken}`)
      .attach('avatar', pngBuffer, { filename: 'avatar.png', contentType: 'image/png' })
      .expect(200)

    expect(response.body).toEqual({
      success: true,
      message: 'Avatar updated successfully',
      data: { avatarUrl: '/uploads/avatars/test-avatar.png' },
    })
  })

  it('DELETE /api/users/me/avatar removes avatar and returns null', async () => {
    vi.spyOn(userService, 'removeAvatar').mockResolvedValueOnce(undefined)

    const response = await request(app)
      .delete('/api/users/me/avatar')
      .set('Authorization', `Bearer ${employeeToken}`)
      .expect(200)

    expect(response.body).toEqual({
      success: true,
      message: 'Avatar removed successfully',
      data: { avatarUrl: null },
    })
  })

  it('POST /api/users/me/change-password validates new password minimum length', async () => {
    await request(app)
      .post('/api/users/me/change-password')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ currentPassword: 'OldPassword123!', newPassword: 'short' })
      .expect(400)
  })

  it('POST /api/users/me/change-password successfully calls changePassword service', async () => {
    vi.spyOn(userService, 'changePassword').mockResolvedValueOnce(undefined)

    const response = await request(app)
      .post('/api/users/me/change-password')
      .set('Authorization', `Bearer ${employeeToken}`)
      .send({ currentPassword: 'OldPassword123!', newPassword: 'NewPassword123!@' })
      .expect(200)

    expect(response.body).toEqual({
      success: true,
      message: 'Password changed successfully',
      data: null,
    })
  })
})
