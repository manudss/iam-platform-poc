// Frozen fictional initial application records. Future changes belong in a new migration.
export const APP_CONNECTOR_DDL = "create table if not exists app_connectors (tenant varchar(32) not null, id varchar(32) not null, name varchar(80) not null, description varchar(240) not null, protocol varchar(8) not null, enabled tinyint not null, config longtext not null, primary key (tenant, id))";
export const DEMO_APP_CONNECTORS = [
  {
    "id": "wiki",
    "name": "Company wiki",
    "description": "Internal knowledge base (fictional). Signs in with OpenID Connect.",
    "protocol": "oidc",
    "enabled": true,
    "redirect_uris": [
      "https://wiki.example.invalid/auth/callback",
      "http://localhost:4300/callback"
    ],
    "entity_id": null,
    "acs_url": null,
    "attribute_mapping": {
      "sub": "id",
      "email": "email",
      "name": "display_name"
    },
    "allowed_roles": [
      "employee"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [
      "profile",
      "email"
    ],
    "allow_refresh_tokens": false,
    "launch_url": "https://wiki.example.invalid/",
    "secret_ref": "apps/wiki/client-secret",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiM1YjIxYjYiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMyA0cTUtMiA5IDEgNC0zIDktMXYxNXEtNS0yLTkgMS00LTMtOS0xek0xMiA1djE1Ii8+PC9nPjwvc3ZnPg=="
  },
  {
    "id": "payroll",
    "name": "Payroll",
    "description": "Payroll portal (fictional). Signs in with SAML 2.0.",
    "protocol": "saml",
    "enabled": true,
    "redirect_uris": [],
    "entity_id": "https://payroll.example.invalid/saml/metadata",
    "acs_url": "https://payroll.example.invalid/saml/acs",
    "attribute_mapping": {
      "NameID": "email",
      "givenName": "display_name",
      "department": "department"
    },
    "allowed_roles": [
      "hr-partner"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [],
    "allow_refresh_tokens": false,
    "launch_url": null,
    "secret_ref": "apps/payroll/signing-key",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiMxZTNhOGEiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNiAzaDEydjE5bC0zLTItMyAyLTMtMi0zIDJ6TTkgOGg2TTkgMTJoNk05IDE2aDMiLz48L2c+PC9zdmc+"
  },
  {
    "id": "crm",
    "name": "Sales CRM",
    "description": "Customer relationship tool (fictional). Signs in with OpenID Connect; still being set up, so disabled.",
    "protocol": "oidc",
    "enabled": false,
    "redirect_uris": [
      "https://crm.example.invalid/oauth/callback",
      "http://localhost:4300/callback"
    ],
    "entity_id": null,
    "acs_url": null,
    "attribute_mapping": {
      "sub": "id",
      "email": "email",
      "groups": "roles"
    },
    "allowed_roles": [
      "sales-rep"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [
      "profile",
      "email",
      "roles"
    ],
    "allow_refresh_tokens": false,
    "launch_url": null,
    "secret_ref": "apps/crm/client-secret",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiNiNDUzMDkiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNCA0djE2aDE3TTggMTVsNC01IDQgMiA1LTciLz48L2c+PC9zdmc+"
  },
  {
    "id": "peoplehub",
    "name": "PeopleHub",
    "description": "HR portal (fictional): directory, time off, org chart. Signs in with OpenID Connect.",
    "protocol": "oidc",
    "enabled": true,
    "redirect_uris": [
      "http://localhost:3000/peoplehub/auth/callback",
      "https://iam-demo-apps.onrender.com/peoplehub/auth/callback",
      "https://peoplehub.apps.dss.name/auth/callback"
    ],
    "entity_id": null,
    "acs_url": null,
    "attribute_mapping": {
      "sub": "id",
      "email": "email",
      "name": "display_name",
      "department": "department",
      "roles": "roles"
    },
    "allowed_roles": [
      "hr-viewer",
      "hr-manager"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [
      "profile",
      "email",
      "roles"
    ],
    "allow_refresh_tokens": false,
    "launch_url": "https://peoplehub.apps.dss.name/",
    "secret_ref": "apps/peoplehub/client-secret",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiMwZjc2NmUiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSI5IiBjeT0iOCIgcj0iMyIvPjxwYXRoIGQ9Ik0zIDIxdi0zYTYgNiAwIDAxMTIgMHYzTTE3IDVhMyAzIDAgMDEwIDZtMSA0YTUgNSAwIDAxMyA2Ii8+PC9nPjwvc3ZnPg=="
  },
  {
    "id": "expenseflow",
    "name": "ExpenseFlow",
    "description": "Expense reports (fictional): submit, approve, track. Signs in with SAML 2.0.",
    "protocol": "saml",
    "enabled": true,
    "redirect_uris": [],
    "entity_id": "https://expenseflow.apps.dss.name/saml/metadata",
    "acs_url": "https://expenseflow.apps.dss.name/saml/acs",
    "attribute_mapping": {
      "NameID": "email",
      "givenName": "display_name",
      "email": "email",
      "department": "department",
      "roles": "roles"
    },
    "allowed_roles": [
      "expense-user",
      "expense-approver"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [],
    "allow_refresh_tokens": false,
    "launch_url": null,
    "secret_ref": "apps/expenseflow/signing-key",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiMxZTNhOGEiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNiAzaDEydjE5bC0zLTItMyAyLTMtMi0zIDJ6TTkgOGg2TTkgMTJoNk05IDE2aDMiLz48L2c+PC9zdmc+"
  },
  {
    "id": "clientdesk",
    "name": "ClientDesk",
    "description": "CRM (fictional): accounts, opportunities, pipeline. Signs in with OpenID Connect.",
    "protocol": "oidc",
    "enabled": true,
    "redirect_uris": [
      "http://localhost:3000/clientdesk/auth/callback",
      "https://iam-demo-apps.onrender.com/clientdesk/auth/callback",
      "https://clientdesk.apps.dss.name/auth/callback"
    ],
    "entity_id": null,
    "acs_url": null,
    "attribute_mapping": {
      "sub": "id",
      "email": "email",
      "name": "display_name",
      "department": "department",
      "roles": "roles"
    },
    "allowed_roles": [
      "sales",
      "sales-manager"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [
      "profile",
      "email",
      "roles"
    ],
    "allow_refresh_tokens": false,
    "launch_url": "https://clientdesk.apps.dss.name/",
    "secret_ref": "apps/clientdesk/client-secret",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiNiNDUzMDkiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNCA0djE2aDE3TTggMTVsNC01IDQgMiA1LTciLz48L2c+PC9zdmc+"
  },
  {
    "id": "ticketly",
    "name": "Ticketly",
    "description": "Support (fictional): tickets, queues, assignment. Signs in with SAML 2.0.",
    "protocol": "saml",
    "enabled": true,
    "redirect_uris": [],
    "entity_id": "https://ticketly.apps.dss.name/saml/metadata",
    "acs_url": "https://ticketly.apps.dss.name/saml/acs",
    "attribute_mapping": {
      "NameID": "email",
      "givenName": "display_name",
      "email": "email",
      "department": "department",
      "roles": "roles"
    },
    "allowed_roles": [
      "ticket-user",
      "ticket-agent"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [],
    "allow_refresh_tokens": false,
    "launch_url": null,
    "secret_ref": "apps/ticketly/signing-key",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiNiZTEyM2MiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMyA3aDE4djRhMyAzIDAgMDAwIDZ2M0gzdi0zYTMgMyAwIDAwMC02ek0xNSA3djNtMCAzdjJtMCAzdjIiLz48L2c+PC9zdmc+"
  },
  {
    "id": "stockroom",
    "name": "StockRoom",
    "description": "Inventory (fictional): stock, supplier orders. Signs in with OpenID Connect.",
    "protocol": "oidc",
    "enabled": true,
    "redirect_uris": [
      "http://localhost:3000/stockroom/auth/callback",
      "https://iam-demo-apps.onrender.com/stockroom/auth/callback",
      "https://stockroom.apps.dss.name/auth/callback"
    ],
    "entity_id": null,
    "acs_url": null,
    "attribute_mapping": {
      "sub": "id",
      "email": "email",
      "name": "display_name",
      "department": "department",
      "roles": "roles"
    },
    "allowed_roles": [
      "stock-viewer",
      "stock-manager"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [
      "profile",
      "email",
      "roles"
    ],
    "allow_refresh_tokens": false,
    "launch_url": "https://stockroom.apps.dss.name/",
    "secret_ref": "apps/stockroom/client-secret",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiM0YjU1NjMiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMyA3bDktNSA5IDV2MTFsLTkgNS05LTV6TTMgN2w5IDUgOS01TTEyIDEydjExTTggNWw5IDUiLz48L2c+PC9zdmc+"
  },
  {
    "id": "timesheet",
    "name": "TimeSheet",
    "description": "Time tracking (fictional): log, approve, report. Signs in with SAML 2.0.",
    "protocol": "saml",
    "enabled": true,
    "redirect_uris": [],
    "entity_id": "https://timesheet.apps.dss.name/saml/metadata",
    "acs_url": "https://timesheet.apps.dss.name/saml/acs",
    "attribute_mapping": {
      "NameID": "email",
      "givenName": "display_name",
      "email": "email",
      "department": "department",
      "roles": "roles"
    },
    "allowed_roles": [
      "time-user",
      "time-approver"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [],
    "allow_refresh_tokens": false,
    "launch_url": null,
    "secret_ref": "apps/timesheet/signing-key",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiMwMzY5YTEiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI5Ii8+PHBhdGggZD0iTTEyIDZ2Nmw0IDMiLz48L2c+PC9zdmc+"
  },
  {
    "id": "learnup",
    "name": "LearnUp",
    "description": "Training (fictional): catalogue, enrolment, progress. Signs in with OpenID Connect.",
    "protocol": "oidc",
    "enabled": true,
    "redirect_uris": [
      "http://localhost:3000/learnup/auth/callback",
      "https://iam-demo-apps.onrender.com/learnup/auth/callback",
      "https://learnup.apps.dss.name/auth/callback"
    ],
    "entity_id": null,
    "acs_url": null,
    "attribute_mapping": {
      "sub": "id",
      "email": "email",
      "name": "display_name",
      "department": "department",
      "roles": "roles"
    },
    "allowed_roles": [
      "learner",
      "trainer"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [
      "profile",
      "email",
      "roles"
    ],
    "allow_refresh_tokens": false,
    "launch_url": "https://learnup.apps.dss.name/",
    "secret_ref": "apps/learnup/client-secret",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiM1YjIxYjYiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMyA0cTUtMiA5IDEgNC0zIDktMXYxNXEtNS0yLTkgMS00LTMtOS0xek0xMiA1djE1Ii8+PC9nPjwvc3ZnPg=="
  },
  {
    "id": "travelops",
    "name": "TravelOps",
    "description": "Travel (fictional): requests, approval, booking. Signs in with SAML 2.0.",
    "protocol": "saml",
    "enabled": true,
    "redirect_uris": [],
    "entity_id": "https://travelops.apps.dss.name/saml/metadata",
    "acs_url": "https://travelops.apps.dss.name/saml/acs",
    "attribute_mapping": {
      "NameID": "email",
      "givenName": "display_name",
      "email": "email",
      "department": "department",
      "roles": "roles"
    },
    "allowed_roles": [
      "traveler",
      "travel-approver"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [],
    "allow_refresh_tokens": false,
    "launch_url": null,
    "secret_ref": "apps/travelops/signing-key",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiMwZTc0OTAiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjEgM0wzIDEwbDcgMyAzIDd6TTEwIDEzbDYtNU0zIDIwbDQtNCIvPjwvZz48L3N2Zz4="
  },
  {
    "id": "sso-config-oidc",
    "name": "SSO Config: OIDC",
    "description": "Guided OpenID Connect configuration (fictional): discovery, endpoints, test sign-in. Signs in with OpenID Connect.",
    "protocol": "oidc",
    "enabled": true,
    "redirect_uris": [
      "http://localhost:3000/sso-config-oidc/auth/callback",
      "https://iam-demo-apps.onrender.com/sso-config-oidc/auth/callback",
      "https://sso-config-oidc.apps.dss.name/auth/callback"
    ],
    "entity_id": null,
    "acs_url": null,
    "attribute_mapping": {
      "sub": "id",
      "email": "email",
      "name": "display_name",
      "department": "department",
      "roles": "roles"
    },
    "allowed_roles": [
      "employee"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [
      "profile",
      "email",
      "roles",
      "offline_access"
    ],
    "allow_refresh_tokens": true,
    "launch_url": "https://sso-config-oidc.apps.dss.name/",
    "secret_ref": "apps/sso-config-oidc/client-secret",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiMwMjg0YzciLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSI4IiBjeT0iOSIgcj0iNSIvPjxwYXRoIGQ9Ik0xMiAxM2w5IDltLTMtMyAzLTNtLTYgMCAzLTMiLz48L2c+PC9zdmc+"
  },
  {
    "id": "sso-config-saml",
    "name": "SSO Config: SAML",
    "description": "Guided SAML 2.0 configuration (fictional): IdP/SP metadata, attribute mapping, test sign-in. Signs in with SAML 2.0.",
    "protocol": "saml",
    "enabled": true,
    "redirect_uris": [],
    "entity_id": "https://sso-config-saml.apps.dss.name/saml/metadata",
    "acs_url": "https://sso-config-saml.apps.dss.name/saml/acs",
    "attribute_mapping": {
      "NameID": "email",
      "givenName": "display_name",
      "email": "email",
      "department": "department",
      "roles": "roles"
    },
    "allowed_roles": [
      "employee"
    ],
    "sp_certificate": null,
    "want_signed_requests": false,
    "nameid_format": null,
    "scopes": [],
    "allow_refresh_tokens": false,
    "launch_url": null,
    "secret_ref": "apps/sso-config-saml/signing-key",
    "logo": "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MCA0MCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iMTAiIGZpbGw9IiM3OTU1YzkiLz48ZyB0cmFuc2Zvcm09InRyYW5zbGF0ZSg3IDcpIiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSI4IiBjeT0iOSIgcj0iNSIvPjxwYXRoIGQ9Ik0xMiAxM2w5IDltLTMtMyAzLTNtLTYgMCAzLTMiLz48L2c+PC9zdmc+"
  }
];
export const appConnectorConfig = (a: any): string => ((a) => JSON.stringify({ logo: a.logo ?? null, redirect_uris: a.redirect_uris, entity_id: a.entity_id, acs_url: a.acs_url, attribute_mapping: a.attribute_mapping, allowed_roles: a.allowed_roles, secret_ref: a.secret_ref, launch_url: a.launch_url, sp_certificate: a.sp_certificate, want_signed_requests: a.want_signed_requests, nameid_format: a.nameid_format, scopes: a.scopes, allow_refresh_tokens: a.allow_refresh_tokens }))(a);
