import { query, execute } from '@/lib/db';
import { User, Organization, UserOrganization } from '@/lib/types';
import type { InValue } from '@libsql/client';

export async function findUserById(id: string): Promise<User | null> {
  console.log('Finding user by ID:', id);
  
  try {
    const users = await query<User>('SELECT * FROM users WHERE id = ?', [id]);
    console.log('User query results:', users.length > 0 ? 'User found' : 'No user found');
    return users.length > 0 ? users[0] : null;
  } catch (error) {
    console.error('Error in findUserById:', error);
    throw error;
  }
}

export async function findUserByEmail(email: string): Promise<User | null> {
  console.log('Finding user by email:', email);
  
  try {
    const users = await query<User>('SELECT * FROM users WHERE email = ?', [email]);
    console.log('User by email results:', users.length > 0 ? 'User found' : 'No user found');
    return users.length > 0 ? users[0] : null;
  } catch (error) {
    console.error('Error in findUserByEmail:', error);
    throw error;
  }
}

export async function createUser(user: {
  id: string;
  login?: string | null;
  name: string | null;
  email: string | null;
  image: string | null;
}): Promise<User> {
  console.log('Creating new user:', user.id, user.email);

  try {
    const result = await execute(
      `INSERT INTO users (id, login, name, email, image) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         login = COALESCE(excluded.login, login),
         name = COALESCE(excluded.name, name),
         email = COALESCE(excluded.email, email),
         image = COALESCE(excluded.image, image)`,
      [user.id, user.login || null, user.name, user.email, user.image]
    );
    
    console.log('User creation result:', result);
    
    const createdUser = await findUserById(user.id);
    if (!createdUser) {
      throw new Error('Failed to retrieve created user');
    }
    
    console.log('User created successfully:', createdUser.id);
    return createdUser;
  } catch (error) {
    console.error('Error in createUser:', error);
    throw error;
  }
}

export async function updateUser(id: string, data: Partial<Omit<User, 'id' | 'created_at' | 'updated_at'>>): Promise<User | null> {
  const updates: string[] = [];
  const values: InValue[] = [];
  
  Object.entries(data).forEach(([key, value]) => {
    if (value !== undefined) {
      updates.push(`${key} = ?`);
      values.push(value);
    }
  });
  
  if (updates.length === 0) {
    return findUserById(id);
  }
  
  updates.push("updated_at = datetime('now')");
  
  await execute(
    `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    [...values, id]
  );
  
  return findUserById(id);
}

export async function getUserOrganizations(userId: string): Promise<Organization[]> {
  return query<Organization>(`
    SELECT o.* 
    FROM organizations o
    JOIN user_organizations uo ON o.id = uo.organization_id
    WHERE uo.user_id = ?
    ORDER BY o.name
  `, [userId]);
}

export async function addUserToOrganization(
  userId: string, 
  organizationId: number, 
  role: UserOrganization['role'] = 'member'
): Promise<void> {
  await execute(
    'INSERT OR IGNORE INTO user_organizations (user_id, organization_id, role) VALUES (?, ?, ?)',
    [userId, organizationId, role]
  );
}

export async function removeUserFromOrganization(userId: string, organizationId: number): Promise<void> {
  await execute(
    'DELETE FROM user_organizations WHERE user_id = ? AND organization_id = ?',
    [userId, organizationId]
  );
}

export async function getOrganizationRole(userId: string, organizationId: number): Promise<UserOrganization['role'] | null> {
  const results = await query<{ role: UserOrganization['role'] }>(
    'SELECT role FROM user_organizations WHERE user_id = ? AND organization_id = ?',
    [userId, organizationId]
  );
  
  return results.length > 0 ? results[0].role : null;
}

export async function updateOrganizationRole(
  userId: string, 
  organizationId: number, 
  role: UserOrganization['role']
): Promise<void> {
  await execute(
    'UPDATE user_organizations SET role = ? WHERE user_id = ? AND organization_id = ?',
    [role, userId, organizationId]
  );
}

export async function findOrCreateUserByGitHubId(userData: {
  id: string; // GitHub user ID
  login: string; // GitHub login/username
  email?: string | null;
  avatar_url?: string | null;
  name?: string | null; // GitHub display name
}): Promise<User> {
  const existingUser = await findUserById(userData.id);
  if (existingUser) {
    const updates: string[] = [];
    const values: (string | null)[] = [];

    // Backfill login for existing users who don't have it yet
    if (!existingUser.login && userData.login) {
      updates.push('login = ?');
      values.push(userData.login);
      existingUser.login = userData.login;
    }

    // Fix name if it was set to the login as a fallback and we now have a real name
    if (userData.name && userData.name !== userData.login && existingUser.name === userData.login) {
      updates.push('name = ?');
      values.push(userData.name);
      existingUser.name = userData.name;
    }

    if (updates.length > 0) {
      values.push(userData.id);
      await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
    }

    return existingUser;
  }

  return createUser({
    id: userData.id,
    login: userData.login,
    name: userData.name || userData.login,
    email: userData.email || null,
    image: userData.avatar_url || null,
  });
}

/**
 * Optimized function to get user with their organizations in a single query
 * This reduces the number of database calls from 2+ to 1
 */
export async function findUserWithOrganizations(
  userId: string
): Promise<{
  user: User;
  organizations: Array<Organization & { role: UserOrganization['role'] }>;
} | null> {
  const results = await query<{
    user_id: string;
    user_login: string | null;
    user_name: string | null;
    user_email: string;
    user_image: string | null;
    user_created_at: string;
    user_updated_at: string;
    org_id: number | null;
    org_name: string | null;
    org_github_id: number | null;
    org_avatar_url: string | null;
    org_installation_id: number | null;
    org_created_at: string | null;
    org_updated_at: string | null;
    role: UserOrganization['role'] | null;
  }>(`
    SELECT 
      u.id as user_id,
      u.login as user_login,
      u.name as user_name,
      u.email as user_email,
      u.image as user_image,
      u.created_at as user_created_at,
      u.updated_at as user_updated_at,
      o.id as org_id,
      o.name as org_name,
      o.github_id as org_github_id,
      o.avatar_url as org_avatar_url,
      o.installation_id as org_installation_id,
      o.created_at as org_created_at,
      o.updated_at as org_updated_at,
      uo.role
    FROM users u
    LEFT JOIN user_organizations uo ON u.id = uo.user_id
    LEFT JOIN organizations o ON uo.organization_id = o.id
    WHERE u.id = ?
    ORDER BY o.created_at ASC
  `, [userId]);

  if (results.length === 0) {
    return null;
  }

  // Extract user data (same for all rows)
  const userData = {
    id: results[0].user_id,
    login: results[0].user_login,
    name: results[0].user_name,
    email: results[0].user_email,
    image: results[0].user_image,
    created_at: results[0].user_created_at,
    updated_at: results[0].user_updated_at
  };

  // Extract unique organizations
  const organizations = results
    .filter(
      (
        row
      ): row is typeof row & {
        org_id: number;
        org_name: string;
        org_github_id: number;
        org_created_at: string;
        org_updated_at: string;
      } =>
        row.org_id !== null &&
        row.org_name !== null &&
        row.org_github_id !== null &&
        row.org_created_at !== null &&
        row.org_updated_at !== null
    )
    .reduce<Array<Organization & { role: UserOrganization['role'] }>>((acc, row) => {
      // Avoid duplicates
      if (!acc.find(org => org.id === row.org_id)) {
        const role: UserOrganization['role'] = row.role ?? 'member';
        acc.push({
          id: row.org_id,
          name: row.org_name,
          github_id: row.org_github_id,
          avatar_url: row.org_avatar_url,
          installation_id: row.org_installation_id,
          created_at: row.org_created_at,
          updated_at: row.org_updated_at,
          role
        });
      }
      return acc;
    }, []);

  return {
    user: userData,
    organizations
  };
} 
