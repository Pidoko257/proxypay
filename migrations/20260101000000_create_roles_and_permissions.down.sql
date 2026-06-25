-- Rollback: 20260101000000_create_roles_and_permissions
DELETE FROM role_permissions;
DELETE FROM permissions;
DELETE FROM roles;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
