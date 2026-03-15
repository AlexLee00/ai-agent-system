'use strict';

const DASHBOARD_POLICY = {
  member: {
    menu: 'dashboard',
    scope: 'self',
    prompt_enabled: false,
    result_canvas_enabled: false,
    operations: ['read'],
  },
  admin: {
    menu: 'dashboard',
    scope: 'team',
    prompt_enabled: true,
    result_canvas_enabled: true,
    operations: ['read', 'prompt', 'dynamic_result'],
  },
  master: {
    menu: 'dashboard',
    scope: 'global',
    prompt_enabled: true,
    result_canvas_enabled: true,
    operations: ['read', 'prompt', 'dynamic_result', 'system_overview'],
  },
};

const ATTENDANCE_POLICY = {
  member: {
    menu: 'attendance',
    scope: 'self',
    prompt_enabled: true,
    confirmation_required: true,
    operations: ['create_today_only'],
  },
  admin: {
    menu: 'attendance',
    scope: 'team',
    prompt_enabled: true,
    confirmation_required: true,
    operations: ['create', 'read', 'update', 'delete'],
  },
  master: {
    menu: 'attendance',
    scope: 'global',
    prompt_enabled: true,
    confirmation_required: true,
    operations: ['create', 'read', 'update', 'delete'],
  },
};

const CRUD_ALL_POLICY = {
  member: { scope: 'company', operations: ['create', 'read', 'update', 'delete'] },
  admin: { scope: 'company', operations: ['create', 'read', 'update', 'delete'] },
  master: { scope: 'global', operations: ['create', 'read', 'update', 'delete'] },
};

const SETTINGS_POLICY = {
  member: {
    menu: 'settings',
    scope: 'self',
    operations: ['change_password'],
    profile_edit_enabled: false,
  },
  admin: {
    menu: 'settings',
    scope: 'self',
    operations: ['read', 'change_password', 'update_profile'],
    profile_edit_enabled: true,
  },
  master: {
    menu: 'settings',
    scope: 'self',
    operations: ['read', 'change_password', 'update_profile', 'system_policy'],
    profile_edit_enabled: true,
  },
};

const CHAT_POLICY = {
  member: {
    menu: 'chat',
    scope: 'self',
    prompt_enabled: true,
    result_canvas_enabled: false,
    operations: ['read', 'prompt'],
  },
  admin: {
    menu: 'chat',
    scope: 'team',
    prompt_enabled: true,
    result_canvas_enabled: true,
    operations: ['read', 'prompt', 'dynamic_result'],
  },
  master: {
    menu: 'chat',
    scope: 'global',
    prompt_enabled: true,
    result_canvas_enabled: true,
    operations: ['read', 'prompt', 'dynamic_result', 'system_overview'],
  },
};

const ADMIN_ONLY_POLICY = {
  member: { operations: [] },
  admin: {
    scope: 'team',
    prompt_enabled: true,
    result_canvas_enabled: true,
    operations: ['read', 'prompt', 'dynamic_result'],
  },
  master: {
    scope: 'global',
    prompt_enabled: true,
    result_canvas_enabled: true,
    operations: ['read', 'prompt', 'dynamic_result', 'system_overview'],
  },
};

function buildCrudPolicy(menu) {
  return {
    member: { menu, ...CRUD_ALL_POLICY.member },
    admin: { menu, ...CRUD_ALL_POLICY.admin },
    master: { menu, ...CRUD_ALL_POLICY.master },
  };
}

function buildAdminOnlyPolicy(menu) {
  return {
    member: { menu, ...ADMIN_ONLY_POLICY.member },
    admin: { menu, ...ADMIN_ONLY_POLICY.admin },
    master: { menu, ...ADMIN_ONLY_POLICY.master },
  };
}

const MENU_POLICY = {
  dashboard: DASHBOARD_POLICY,
  attendance: ATTENDANCE_POLICY,
  chat: CHAT_POLICY,
  schedules: buildCrudPolicy('schedules'),
  sales: buildCrudPolicy('sales'),
  projects: buildCrudPolicy('projects'),
  journals: buildCrudPolicy('journals'),
  settings: SETTINGS_POLICY,
  ai: buildAdminOnlyPolicy('ai'),
  workforce: buildAdminOnlyPolicy('workforce'),
  approvals: buildAdminOnlyPolicy('approvals'),
};

function getMenuPolicyForRole(role = 'member') {
  const safeRole = ['member', 'admin', 'master'].includes(role) ? role : 'member';
  return Object.fromEntries(
    Object.entries(MENU_POLICY).map(([menu, byRole]) => [menu, byRole[safeRole] || byRole.member])
  );
}

module.exports = {
  MENU_POLICY,
  getMenuPolicyForRole,
};
