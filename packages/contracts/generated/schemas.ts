// ⚠️ 本文件由 packages/contracts/scripts/generate.mjs 生成，请勿手工修改。
// 契约的唯一事实来源是 packages/contracts/schemas/**/*.json。
// 修改契约后运行：pnpm -C packages/contracts gen

import type { JsonSchema } from '../src/json-schema.js';

/** LoginRequest — schemas/auth/login.json */
export const authLoginSchema = {
    "$id": "auth/login",
    "title": "LoginRequest",
    "description": "登录请求体（docs/architecture-design.md §3.4）",
    "type": "object",
    "properties": {
      "username": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "password": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      }
    },
    "required": [
      "username",
      "password"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** SessionResponse — schemas/auth/session.json */
export const authSessionSchema = {
    "$id": "auth/session",
    "title": "SessionResponse",
    "description": "当前会话视图（GET /api/me、登录成功后的响应体）；资料、能力与有效范围一次返回，供前端裁剪导航与操作区（docs/permission-design.md §6.1）",
    "type": "object",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "user": {
            "type": "object",
            "description": "本人资料（不含能力与范围；它们与 user 平级，便于前端分别驱动导航与授权面板）",
            "properties": {
              "id": {
                "type": "string",
                "description": "不透明用户 id，如 usr_xxx"
              },
              "username": {
                "type": "string",
                "description": "登录名，全局唯一"
              },
              "displayName": {
                "type": "string"
              },
              "email": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "phone": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "identity": {
                "type": "string",
                "enum": [
                  "owner",
                  "user_admin",
                  "member"
                ],
                "description": "互斥身份"
              },
              "status": {
                "type": "string",
                "enum": [
                  "active",
                  "disabled"
                ]
              },
              "mustChangePassword": {
                "type": "boolean",
                "description": "为 true 时前端强制进入修改密码流程"
              },
              "managedByUserIds": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "管理归属，可含多位用户管理员；空数组 = 未指派"
              }
            },
            "required": [
              "id",
              "username",
              "displayName",
              "email",
              "phone",
              "identity",
              "status",
              "mustChangePassword",
              "managedByUserIds"
            ],
            "additionalProperties": false
          },
          "capabilities": {
            "type": "array",
            "description": "业务能力；每条 = 能力 + 绑定的资源范围（目标字段与 viewGrants 统一为 targetType/targetId）",
            "items": {
              "type": "object",
              "properties": {
                "capability": {
                  "type": "string",
                  "enum": [
                    "blueprint.manage",
                    "blueprint.publish"
                  ]
                },
                "targetType": {
                  "type": "string",
                  "enum": [
                    "group",
                    "blueprint"
                  ]
                },
                "targetId": {
                  "type": "string"
                }
              },
              "required": [
                "capability",
                "targetType",
                "targetId"
              ],
              "additionalProperties": false
            }
          },
          "viewGrants": {
            "type": "array",
            "description": "本人获得的查看授权（含他人授予的只读项）",
            "items": {
              "type": "object",
              "properties": {
                "targetType": {
                  "type": "string",
                  "enum": [
                    "group",
                    "blueprint"
                  ]
                },
                "targetId": {
                  "type": "string"
                },
                "grantedByUserId": {
                  "type": "string"
                },
                "grantedByDisplayName": {
                  "type": "string",
                  "description": "授予者姓名，前端直接展示「由 X 授予」"
                },
                "grantedAt": {
                  "type": "string",
                  "format": "date-time"
                }
              },
              "required": [
                "targetType",
                "targetId",
                "grantedByUserId",
                "grantedByDisplayName",
                "grantedAt"
              ],
              "additionalProperties": false
            }
          },
          "delegableScopes": {
            "type": "array",
            "description": "可委派范围（派生字段）：用户管理员等于其自身查看范围；其他身份为空数组",
            "items": {
              "type": "object",
              "properties": {
                "targetType": {
                  "type": "string",
                  "enum": [
                    "group",
                    "blueprint"
                  ]
                },
                "targetId": {
                  "type": "string"
                }
              },
              "required": [
                "targetType",
                "targetId"
              ],
              "additionalProperties": false
            }
          }
        },
        "required": [
          "user",
          "capabilities",
          "viewGrants",
          "delegableScopes"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string"
          }
        },
        "required": [
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** CreateBlueprintGroupRequest — schemas/blueprint-groups/create.json */
export const blueprintGroupsCreateSchema = {
    "$id": "blueprint-groups/create",
    "title": "CreateBlueprintGroupRequest",
    "description": "POST /api/blueprint-groups 请求体（docs/permission-design.md §6.4）：新建分组需覆盖目标范围的 blueprint.manage",
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "分组名，全局唯一"
      },
      "sortOrder": {
        "type": "integer",
        "minimum": 0,
        "description": "排序序号；省略则排到最后"
      }
    },
    "required": [
      "name"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** BlueprintGroupsListResponse — schemas/blueprint-groups/list.json */
export const blueprintGroupsListSchema = {
    "$id": "blueprint-groups/list",
    "title": "BlueprintGroupsListResponse",
    "description": "GET /api/blueprint-groups 响应（docs/permission-design.md §6.4）：只返回授权范围内的分组；M1 仅需分组最小形状，M2 再扩展蓝图字段",
    "type": "object",
    "$defs": {
      "BlueprintGroupSummary": {
        "type": "object",
        "description": "分组摘要",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明分组 id，如 grp_xxx"
          },
          "name": {
            "type": "string",
            "description": "分组名，全局唯一"
          },
          "isDefault": {
            "type": "boolean",
            "description": "是否默认分组（不可归档、恒首位）"
          },
          "sortOrder": {
            "type": "integer",
            "minimum": 0,
            "description": "排序序号，越小越靠前"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间（ISO 8601）；null = 未归档"
          },
          "blueprintCount": {
            "type": "integer",
            "minimum": 0,
            "description": "该分组下可见蓝图数量（卡片数与区头计数同源）"
          }
        },
        "required": [
          "id",
          "name",
          "isDefault",
          "sortOrder",
          "archivedAt",
          "blueprintCount"
        ],
        "additionalProperties": false
      }
    },
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BlueprintGroupSummary"
            },
            "description": "当前页分组列表"
          }
        },
        "required": [
          "items"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "page": {
            "type": "integer",
            "minimum": 1,
            "description": "当前页码，从 1 开始"
          },
          "pageSize": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "description": "每页条数，默认 20，上限 100"
          },
          "total": {
            "type": "integer",
            "minimum": 0,
            "description": "过滤后的总条数"
          },
          "requestId": {
            "type": "string",
            "description": "请求 id，用于日志追溯"
          }
        },
        "required": [
          "page",
          "pageSize",
          "total",
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** BlueprintGroupMutationResponse — schemas/blueprint-groups/mutation.json */
export const blueprintGroupsMutationSchema = {
    "$id": "blueprint-groups/mutation",
    "title": "BlueprintGroupMutationResponse",
    "description": "分组写操作的响应（新建 / 归档 / 恢复 / 排序）：返回受影响分组的当前状态 + 回落信息，前端据此就地更新",
    "type": "object",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "group": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "分组 id"
              },
              "name": {
                "type": "string",
                "description": "分组名"
              },
              "isDefault": {
                "type": "boolean",
                "description": "是否默认分组"
              },
              "sortOrder": {
                "type": "integer",
                "minimum": 0,
                "description": "排序序号"
              },
              "archivedAt": {
                "type": [
                  "string",
                  "null"
                ],
                "format": "date-time",
                "description": "归档时间；null = 未归档"
              }
            },
            "required": [
              "id",
              "name",
              "isDefault",
              "sortOrder",
              "archivedAt"
            ],
            "additionalProperties": false
          },
          "movedBlueprintIds": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "归档分组时回落到默认分组的蓝图 id（其他操作恒为空数组）"
          }
        },
        "required": [
          "group",
          "movedBlueprintIds"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string",
            "description": "请求 id"
          }
        },
        "required": [
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** ReorderBlueprintGroupsRequest — schemas/blueprint-groups/reorder.json */
export const blueprintGroupsReorderSchema = {
    "$id": "blueprint-groups/reorder",
    "title": "ReorderBlueprintGroupsRequest",
    "description": "PATCH /api/blueprint-groups/reorder 请求体（docs/permission-design.md §6.4）：默认分组恒首位，不接受出现在 orderedIds 里",
    "type": "object",
    "properties": {
      "orderedIds": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "minItems": 1,
        "maxItems": 200,
        "description": "按目标顺序排列的非默认分组 id 列表（必须与当前分组集合完全一致，否则 INVALID_ARGUMENT）"
      }
    },
    "required": [
      "orderedIds"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** CreateBlueprintRequest — schemas/blueprints/create.json */
export const blueprintsCreateSchema = {
    "$id": "blueprints/create",
    "title": "CreateBlueprintRequest",
    "description": "POST /api/blueprints 的字段契约（docs/permission-design.md §6.4）。注意：实际请求是 multipart/form-data —— 这些字段随产物包一起提交，服务端解析 form 字段后按本 schema 校验",
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120,
        "description": "蓝图名称"
      },
      "summary": {
        "type": "string",
        "maxLength": 2000,
        "description": "概述，默认空串"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 32
        },
        "maxItems": 20,
        "description": "标签"
      },
      "groupId": {
        "type": "string",
        "description": "所属分组 id；省略则落到默认分组"
      },
      "version": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        "description": "首个版本号"
      },
      "publishNote": {
        "type": "string",
        "maxLength": 500,
        "description": "发布说明，默认空串"
      },
      "idempotencyKey": {
        "type": "string",
        "maxLength": 128,
        "description": "幂等键；同一键重复提交返回首次结果"
      }
    },
    "required": [
      "name",
      "version"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** BlueprintDetailResponse — schemas/blueprints/detail.json */
export const blueprintsDetailSchema = {
    "$id": "blueprints/detail",
    "$defs": {
      "BlueprintSummary": {
        "type": "object",
        "description": "蓝图卡片摘要；列表一次返回卡片所需全部字段（禁止前端 N+1 补拉，architecture-design §6.4）",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明蓝图 id，如 bp_xxx"
          },
          "name": {
            "type": "string",
            "description": "蓝图名称"
          },
          "summary": {
            "type": "string",
            "description": "概述"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "标签"
          },
          "groupId": {
            "type": "string",
            "description": "所属分组 id"
          },
          "groupName": {
            "type": "string",
            "description": "所属分组名（卡片上直接呈现，避免再查分组表）"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ],
            "description": "蓝图状态"
          },
          "versionCount": {
            "type": "integer",
            "minimum": 0,
            "description": "可用版本数量（不含已归档版本）"
          },
          "latestVersion": {
            "oneOf": [
              {
                "$ref": "#/$defs/BlueprintVersionSummary"
              },
              {
                "type": "null"
              }
            ],
            "description": "最新版本摘要；无任何版本时为 null"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "description": "最近更新时间（ISO 8601）"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "id",
          "name",
          "summary",
          "tags",
          "groupId",
          "groupName",
          "status",
          "versionCount",
          "latestVersion",
          "createdAt",
          "updatedAt",
          "archivedAt"
        ],
        "additionalProperties": false
      },
      "BlueprintVersionSummary": {
        "type": "object",
        "description": "版本摘要；列表与详情共用",
        "properties": {
          "version": {
            "type": "string",
            "description": "版本号，同一蓝图内唯一"
          },
          "isLatest": {
            "type": "boolean",
            "description": "是否为当前最新版本"
          },
          "status": {
            "type": "string",
            "enum": [
              "available",
              "missing"
            ],
            "description": "产物是否完整可预览"
          },
          "publishSource": {
            "type": "string",
            "enum": [
              "mcp",
              "web",
              "web-cover"
            ],
            "description": "发布来源：mcp / 页内发布 / 页内覆盖"
          },
          "publishNote": {
            "type": "string",
            "description": "发布说明"
          },
          "deployedAt": {
            "type": "string",
            "format": "date-time",
            "description": "发布时间（ISO 8601）"
          },
          "artifactBytes": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "description": "产物字节数，未知为 null"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "version",
          "isLatest",
          "status",
          "publishSource",
          "publishNote",
          "deployedAt",
          "artifactBytes",
          "archivedAt"
        ],
        "additionalProperties": false
      }
    },
    "title": "BlueprintDetailResponse",
    "description": "GET /api/blueprints/:id 响应（docs/permission-design.md §6.4）：单蓝图详情与全部版本（含已归档版本，供恢复）",
    "type": "object",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "blueprint": {
            "$ref": "#/$defs/BlueprintSummary"
          },
          "versions": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BlueprintVersionSummary"
            },
            "description": "版本列表，按发布时间倒序"
          },
          "capabilities": {
            "type": "object",
            "description": "当前请求者对这一蓝图的操作能力，前端据此装配操作区（不按身份猜）",
            "properties": {
              "canManage": {
                "type": "boolean",
                "description": "可维护（改名、移动、归档、覆盖、归档版本）"
              },
              "canPublish": {
                "type": "boolean",
                "description": "可发布新版本"
              }
            },
            "required": [
              "canManage",
              "canPublish"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "blueprint",
          "versions",
          "capabilities"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string",
            "description": "请求 id"
          }
        },
        "required": [
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** BlueprintsListResponse — schemas/blueprints/list.json */
export const blueprintsListSchema = {
    "$id": "blueprints/list",
    "$defs": {
      "BlueprintVersionSummary": {
        "type": "object",
        "description": "版本摘要；列表与详情共用",
        "properties": {
          "version": {
            "type": "string",
            "description": "版本号，同一蓝图内唯一"
          },
          "isLatest": {
            "type": "boolean",
            "description": "是否为当前最新版本"
          },
          "status": {
            "type": "string",
            "enum": [
              "available",
              "missing"
            ],
            "description": "产物是否完整可预览"
          },
          "publishSource": {
            "type": "string",
            "enum": [
              "mcp",
              "web",
              "web-cover"
            ],
            "description": "发布来源：mcp / 页内发布 / 页内覆盖"
          },
          "publishNote": {
            "type": "string",
            "description": "发布说明"
          },
          "deployedAt": {
            "type": "string",
            "format": "date-time",
            "description": "发布时间（ISO 8601）"
          },
          "artifactBytes": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "description": "产物字节数，未知为 null"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "version",
          "isLatest",
          "status",
          "publishSource",
          "publishNote",
          "deployedAt",
          "artifactBytes",
          "archivedAt"
        ],
        "additionalProperties": false
      },
      "BlueprintSummary": {
        "type": "object",
        "description": "蓝图卡片摘要；列表一次返回卡片所需全部字段（禁止前端 N+1 补拉，architecture-design §6.4）",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明蓝图 id，如 bp_xxx"
          },
          "name": {
            "type": "string",
            "description": "蓝图名称"
          },
          "summary": {
            "type": "string",
            "description": "概述"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "标签"
          },
          "groupId": {
            "type": "string",
            "description": "所属分组 id"
          },
          "groupName": {
            "type": "string",
            "description": "所属分组名（卡片上直接呈现，避免再查分组表）"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ],
            "description": "蓝图状态"
          },
          "versionCount": {
            "type": "integer",
            "minimum": 0,
            "description": "可用版本数量（不含已归档版本）"
          },
          "latestVersion": {
            "oneOf": [
              {
                "$ref": "#/$defs/BlueprintVersionSummary"
              },
              {
                "type": "null"
              }
            ],
            "description": "最新版本摘要；无任何版本时为 null"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "description": "最近更新时间（ISO 8601）"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "id",
          "name",
          "summary",
          "tags",
          "groupId",
          "groupName",
          "status",
          "versionCount",
          "latestVersion",
          "createdAt",
          "updatedAt",
          "archivedAt"
        ],
        "additionalProperties": false
      }
    },
    "title": "BlueprintsListResponse",
    "description": "GET /api/blueprints 响应（docs/permission-design.md §6.4）：只返回授权范围内可见的蓝图；服务端过滤与分页，前端不再补拉详情",
    "type": "object",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/BlueprintSummary"
            },
            "description": "当前页蓝图卡片"
          },
          "groups": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "id": {
                  "type": "string",
                  "description": "分组 id"
                },
                "name": {
                  "type": "string",
                  "description": "分组名"
                },
                "isDefault": {
                  "type": "boolean",
                  "description": "是否默认分组"
                },
                "sortOrder": {
                  "type": "integer",
                  "minimum": 0,
                  "description": "排序序号"
                },
                "blueprintCount": {
                  "type": "integer",
                  "minimum": 0,
                  "description": "该分组下可见蓝图数量"
                }
              },
              "required": [
                "id",
                "name",
                "isDefault",
                "sortOrder",
                "blueprintCount"
              ],
              "additionalProperties": false
            },
            "description": "全部分组（含空分组，供拖拽落位；默认分组恒首位）"
          }
        },
        "required": [
          "items",
          "groups"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "page": {
            "type": "integer",
            "minimum": 1,
            "description": "当前页码，从 1 开始"
          },
          "pageSize": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "description": "每页条数，默认 20，上限 100"
          },
          "total": {
            "type": "integer",
            "minimum": 0,
            "description": "过滤后的总条数"
          },
          "requestId": {
            "type": "string",
            "description": "请求 id，用于日志追溯"
          }
        },
        "required": [
          "page",
          "pageSize",
          "total",
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** BlueprintMutationResponse — schemas/blueprints/mutation.json */
export const blueprintsMutationSchema = {
    "$id": "blueprints/mutation",
    "title": "BlueprintMutationResponse",
    "description": "蓝图与版本写操作的统一响应（创建 / 发布 / 覆盖 / 归档 / 恢复）：返回被改动对象的当前状态",
    "type": "object",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "blueprint": {
            "$ref": "#/$defs/BlueprintSummary"
          },
          "version": {
            "oneOf": [
              {
                "$ref": "#/$defs/BlueprintVersionSummary"
              },
              {
                "type": "null"
              }
            ],
            "description": "本次操作涉及的版本；归档/恢复蓝图时为 null"
          }
        },
        "required": [
          "blueprint",
          "version"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string",
            "description": "请求 id"
          }
        },
        "required": [
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false,
    "$defs": {
      "BlueprintSummary": {
        "type": "object",
        "description": "蓝图卡片摘要；列表一次返回卡片所需全部字段（禁止前端 N+1 补拉，architecture-design §6.4）",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明蓝图 id，如 bp_xxx"
          },
          "name": {
            "type": "string",
            "description": "蓝图名称"
          },
          "summary": {
            "type": "string",
            "description": "概述"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "标签"
          },
          "groupId": {
            "type": "string",
            "description": "所属分组 id"
          },
          "groupName": {
            "type": "string",
            "description": "所属分组名（卡片上直接呈现，避免再查分组表）"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ],
            "description": "蓝图状态"
          },
          "versionCount": {
            "type": "integer",
            "minimum": 0,
            "description": "可用版本数量（不含已归档版本）"
          },
          "latestVersion": {
            "oneOf": [
              {
                "$ref": "#/$defs/BlueprintVersionSummary"
              },
              {
                "type": "null"
              }
            ],
            "description": "最新版本摘要；无任何版本时为 null"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "description": "最近更新时间（ISO 8601）"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "id",
          "name",
          "summary",
          "tags",
          "groupId",
          "groupName",
          "status",
          "versionCount",
          "latestVersion",
          "createdAt",
          "updatedAt",
          "archivedAt"
        ],
        "additionalProperties": false
      },
      "BlueprintVersionSummary": {
        "type": "object",
        "description": "版本摘要；列表与详情共用",
        "properties": {
          "version": {
            "type": "string",
            "description": "版本号，同一蓝图内唯一"
          },
          "isLatest": {
            "type": "boolean",
            "description": "是否为当前最新版本"
          },
          "status": {
            "type": "string",
            "enum": [
              "available",
              "missing"
            ],
            "description": "产物是否完整可预览"
          },
          "publishSource": {
            "type": "string",
            "enum": [
              "mcp",
              "web",
              "web-cover"
            ],
            "description": "发布来源：mcp / 页内发布 / 页内覆盖"
          },
          "publishNote": {
            "type": "string",
            "description": "发布说明"
          },
          "deployedAt": {
            "type": "string",
            "format": "date-time",
            "description": "发布时间（ISO 8601）"
          },
          "artifactBytes": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "description": "产物字节数，未知为 null"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "version",
          "isLatest",
          "status",
          "publishSource",
          "publishNote",
          "deployedAt",
          "artifactBytes",
          "archivedAt"
        ],
        "additionalProperties": false
      }
    }
  } as const satisfies JsonSchema;

/** PublishBlueprintVersionRequest — schemas/blueprints/publish-version.json */
export const blueprintsPublishVersionSchema = {
    "$id": "blueprints/publish-version",
    "title": "PublishBlueprintVersionRequest",
    "description": "POST /api/blueprints/:id/versions 的字段契约（multipart）：发布新版本并置为最新",
    "type": "object",
    "properties": {
      "version": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        "description": "版本号，同蓝图内唯一"
      },
      "publishNote": {
        "type": "string",
        "maxLength": 500,
        "description": "发布说明"
      },
      "makeLatest": {
        "type": "boolean",
        "description": "是否置为最新版本；省略时按 true 处理（发布即置最新）"
      }
    },
    "required": [
      "version"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** UpdateBlueprintRequest — schemas/blueprints/update.json */
export const blueprintsUpdateSchema = {
    "$id": "blueprints/update",
    "title": "UpdateBlueprintRequest",
    "description": "PATCH /api/blueprints/:id 请求体（docs/permission-design.md §6.4）：改元数据、移动分组、归档；不含产物",
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120,
        "description": "蓝图名称"
      },
      "summary": {
        "type": "string",
        "maxLength": 2000,
        "description": "概述"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 32
        },
        "maxItems": 20,
        "description": "标签（整体替换）"
      },
      "groupId": {
        "type": "string",
        "description": "移动到的分组 id（归档分组与默认分组都不可作为目标时由服务端拒绝）"
      },
      "status": {
        "type": "string",
        "enum": [
          "active",
          "archived"
        ],
        "description": "改为 archived 即归档（不物理删除产物，可恢复）"
      }
    },
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** ErrorResponse — schemas/common/error.json */
export const commonErrorSchema = {
    "$id": "common/error",
    "title": "ErrorResponse",
    "description": "统一错误信封：所有非 2xx 响应体（docs/architecture-design.md §6.2）",
    "type": "object",
    "properties": {
      "error": {
        "type": "object",
        "properties": {
          "code": {
            "type": "string",
            "description": "稳定错误码，前端只按 code 分支，禁止解析 message 文本"
          },
          "message": {
            "type": "string",
            "description": "面向用户的中文说明，可随文案演进"
          },
          "details": {
            "type": "object",
            "additionalProperties": true,
            "description": "结构化补充信息，如 outOfScope / current / field"
          },
          "requestId": {
            "type": "string"
          }
        },
        "required": [
          "code",
          "message",
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "error"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** EmbedTicketRequest — schemas/embed/ticket.json */
export const embedTicketSchema = {
    "$id": "embed/ticket",
    "title": "EmbedTicketRequest",
    "description": "POST /api/embed/tickets 请求体（docs/architecture-design.md §3.7 嵌入场景）：共享密钥放在 X-Embed-Secret 头，不放请求体",
    "type": "object",
    "required": [
      "blueprintId"
    ],
    "properties": {
      "blueprintId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "version": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "嵌入时通常固定版本；省略取最新未归档版本"
      }
    },
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** McpConnectionInfoResponse — schemas/mcp/connection-info.json */
export const mcpConnectionInfoSchema = {
    "$id": "mcp/connection-info",
    "title": "McpConnectionInfoResponse",
    "description": "MCP 接入向导所需的连接事实（docs/mcp-onboarding-design.md §3.1）。客户端片段由这些事实生成，前端不再硬编码服务地址。",
    "type": "object",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "enabled": {
            "type": "boolean",
            "description": "服务端是否启用了 MCP（MCP_ENABLED）；false 时本接口返回 503"
          },
          "httpUrl": {
            "type": "string",
            "description": "客户端应填的完整 MCP 地址（API_PUBLIC_BASE_URL 的 origin + MCP_PATH）"
          },
          "path": {
            "type": "string",
            "description": "MCP 路径，带前导斜杠"
          },
          "transport": {
            "type": "string",
            "enum": [
              "streamable-http"
            ]
          },
          "authHeader": {
            "type": "string"
          },
          "authScheme": {
            "type": "string",
            "enum": [
              "Bearer"
            ]
          },
          "protocol": {
            "type": "object",
            "properties": {
              "negotiatedBy": {
                "type": "string",
                "enum": [
                  "client-initialize"
                ],
                "description": "协议版本由客户端 initialize 协商，接入方无需手动指定"
              },
              "modernEra": {
                "type": "boolean",
                "description": "支持 2026-07-28 及以后的 stateless envelope 时代"
              },
              "legacyEra": {
                "type": "boolean",
                "description": "支持 initialize 时代（旧客户端，含 HTTP+SSE 风格响应）"
              }
            },
            "required": [
              "negotiatedBy",
              "modernEra",
              "legacyEra"
            ],
            "additionalProperties": false
          },
          "oauth": {
            "type": "object",
            "properties": {
              "enabled": {
                "type": "boolean"
              },
              "note": {
                "type": "string"
              }
            },
            "required": [
              "enabled",
              "note"
            ],
            "additionalProperties": false
          },
          "tools": {
            "type": "object",
            "properties": {
              "total": {
                "type": "integer",
                "minimum": 0
              },
              "read": {
                "type": "integer",
                "minimum": 0
              },
              "write": {
                "type": "integer",
                "minimum": 0
              }
            },
            "required": [
              "total",
              "read",
              "write"
            ],
            "additionalProperties": false,
            "description": "工具口径的唯一来源（§3.5 P6：此前组件/技能文档/实际数量三处不一致）"
          },
          "scopes": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "read:blueprint",
                "publish:blueprint"
              ]
            },
            "description": "可用 scope 取值"
          },
          "tokenPagePath": {
            "type": "string",
            "description": "前端创建/管理 Token 的页面路径"
          }
        },
        "required": [
          "enabled",
          "httpUrl",
          "path",
          "transport",
          "authHeader",
          "authScheme",
          "protocol",
          "oauth",
          "tools",
          "scopes",
          "tokenPagePath"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string"
          }
        },
        "required": [
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** McpCoverBlueprintVersionOutput — schemas/mcp/cover-blueprint-version-output.json */
export const mcpCoverBlueprintVersionOutputSchema = {
    "$id": "mcp/cover-blueprint-version-output",
    "title": "McpCoverBlueprintVersionOutput",
    "description": "MCP 工具 youzhao.cover_blueprint_version 的返回结构：被覆盖的原有版本与覆盖后的版本。",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "blueprint": {
        "$ref": "#/$defs/BlueprintSummary"
      },
      "version": {
        "oneOf": [
          {
            "$ref": "#/$defs/BlueprintVersionSummary"
          },
          {
            "type": "null"
          }
        ],
        "description": "本次操作涉及的版本；归档/恢复蓝图时为 null"
      }
    },
    "required": [
      "blueprint",
      "version"
    ],
    "$defs": {
      "BlueprintSummary": {
        "type": "object",
        "description": "蓝图卡片摘要；列表一次返回卡片所需全部字段（禁止前端 N+1 补拉，architecture-design §6.4）",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明蓝图 id，如 bp_xxx"
          },
          "name": {
            "type": "string",
            "description": "蓝图名称"
          },
          "summary": {
            "type": "string",
            "description": "概述"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "标签"
          },
          "groupId": {
            "type": "string",
            "description": "所属分组 id"
          },
          "groupName": {
            "type": "string",
            "description": "所属分组名（卡片上直接呈现，避免再查分组表）"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ],
            "description": "蓝图状态"
          },
          "versionCount": {
            "type": "integer",
            "minimum": 0,
            "description": "可用版本数量（不含已归档版本）"
          },
          "latestVersion": {
            "oneOf": [
              {
                "$ref": "#/$defs/BlueprintVersionSummary"
              },
              {
                "type": "null"
              }
            ],
            "description": "最新版本摘要；无任何版本时为 null"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "description": "最近更新时间（ISO 8601）"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "id",
          "name",
          "summary",
          "tags",
          "groupId",
          "groupName",
          "status",
          "versionCount",
          "latestVersion",
          "createdAt",
          "updatedAt",
          "archivedAt"
        ],
        "additionalProperties": false
      },
      "BlueprintVersionSummary": {
        "type": "object",
        "description": "版本摘要；列表与详情共用",
        "properties": {
          "version": {
            "type": "string",
            "description": "版本号，同一蓝图内唯一"
          },
          "isLatest": {
            "type": "boolean",
            "description": "是否为当前最新版本"
          },
          "status": {
            "type": "string",
            "enum": [
              "available",
              "missing"
            ],
            "description": "产物是否完整可预览"
          },
          "publishSource": {
            "type": "string",
            "enum": [
              "mcp",
              "web",
              "web-cover"
            ],
            "description": "发布来源：mcp / 页内发布 / 页内覆盖"
          },
          "publishNote": {
            "type": "string",
            "description": "发布说明"
          },
          "deployedAt": {
            "type": "string",
            "format": "date-time",
            "description": "发布时间（ISO 8601）"
          },
          "artifactBytes": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "description": "产物字节数，未知为 null"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "version",
          "isLatest",
          "status",
          "publishSource",
          "publishNote",
          "deployedAt",
          "artifactBytes",
          "archivedAt"
        ],
        "additionalProperties": false
      }
    }
  } as const satisfies JsonSchema;

/** McpCoverBlueprintVersionInput — schemas/mcp/cover-blueprint-version.json */
export const mcpCoverBlueprintVersionSchema = {
    "$id": "mcp/cover-blueprint-version",
    "title": "McpCoverBlueprintVersionInput",
    "description": "MCP 工具 youzhao_cover_blueprint_version 的入参：用新产物覆盖一个已存在版本的产物，版本号与元数据不变",
    "type": "object",
    "properties": {
      "blueprintId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "蓝图 id，如 bp_xxx"
      },
      "version": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        "description": "要被覆盖的版本号"
      },
      "html": {
        "type": "string",
        "description": "产物入口 HTML 文本"
      },
      "markdown": {
        "type": "string",
        "description": "产物配套 Markdown"
      },
      "publishNote": {
        "type": "string",
        "maxLength": 500,
        "description": "覆盖说明"
      },
      "idempotencyKey": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "description": "相同 key 的重复调用返回同一结果"
      }
    },
    "required": [
      "blueprintId",
      "version",
      "html"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** McpCreateBlueprintGroupOutput — schemas/mcp/create-blueprint-group-output.json */
export const mcpCreateBlueprintGroupOutputSchema = {
    "$id": "mcp/create-blueprint-group-output",
    "title": "McpCreateBlueprintGroupOutput",
    "description": "MCP 工具 youzhao.create_blueprint_group 的返回结构：新建的分组。",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "group": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "分组 id"
          },
          "name": {
            "type": "string",
            "description": "分组名"
          },
          "isDefault": {
            "type": "boolean",
            "description": "是否默认分组"
          },
          "sortOrder": {
            "type": "integer",
            "minimum": 0,
            "description": "排序序号"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          },
          "blueprintCount": {
            "type": "integer",
            "minimum": 0,
            "description": "分组内蓝图数（新建时为 0）"
          }
        },
        "required": [
          "id",
          "name",
          "isDefault",
          "sortOrder",
          "archivedAt",
          "blueprintCount"
        ],
        "additionalProperties": false
      },
      "movedBlueprintIds": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "归档分组时回落到默认分组的蓝图 id（其他操作恒为空数组）"
      }
    },
    "required": [
      "group",
      "movedBlueprintIds"
    ]
  } as const satisfies JsonSchema;

/** McpCreateBlueprintGroupInput — schemas/mcp/create-blueprint-group.json */
export const mcpCreateBlueprintGroupSchema = {
    "$id": "mcp/create-blueprint-group",
    "title": "McpCreateBlueprintGroupInput",
    "description": "MCP 工具 youzhao_create_blueprint_group 的入参：新建一个蓝图分组",
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 40,
        "description": "分组名，全局唯一"
      },
      "idempotencyKey": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "description": "相同 key 的重复调用返回同一结果"
      }
    },
    "required": [
      "name"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** McpDeleteBlueprintVersionOutput — schemas/mcp/delete-blueprint-version-output.json */
export const mcpDeleteBlueprintVersionOutputSchema = {
    "$id": "mcp/delete-blueprint-version-output",
    "title": "McpDeleteBlueprintVersionOutput",
    "description": "MCP 工具 youzhao.delete_blueprint_version 的返回结构：蓝图与归档后的版本。",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "blueprint": {
        "$ref": "#/$defs/BlueprintSummary"
      },
      "version": {
        "oneOf": [
          {
            "$ref": "#/$defs/BlueprintVersionSummary"
          },
          {
            "type": "null"
          }
        ],
        "description": "本次操作涉及的版本；归档/恢复蓝图时为 null"
      }
    },
    "required": [
      "blueprint",
      "version"
    ],
    "$defs": {
      "BlueprintSummary": {
        "type": "object",
        "description": "蓝图卡片摘要；列表一次返回卡片所需全部字段（禁止前端 N+1 补拉，architecture-design §6.4）",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明蓝图 id，如 bp_xxx"
          },
          "name": {
            "type": "string",
            "description": "蓝图名称"
          },
          "summary": {
            "type": "string",
            "description": "概述"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "标签"
          },
          "groupId": {
            "type": "string",
            "description": "所属分组 id"
          },
          "groupName": {
            "type": "string",
            "description": "所属分组名（卡片上直接呈现，避免再查分组表）"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ],
            "description": "蓝图状态"
          },
          "versionCount": {
            "type": "integer",
            "minimum": 0,
            "description": "可用版本数量（不含已归档版本）"
          },
          "latestVersion": {
            "oneOf": [
              {
                "$ref": "#/$defs/BlueprintVersionSummary"
              },
              {
                "type": "null"
              }
            ],
            "description": "最新版本摘要；无任何版本时为 null"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "description": "最近更新时间（ISO 8601）"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "id",
          "name",
          "summary",
          "tags",
          "groupId",
          "groupName",
          "status",
          "versionCount",
          "latestVersion",
          "createdAt",
          "updatedAt",
          "archivedAt"
        ],
        "additionalProperties": false
      },
      "BlueprintVersionSummary": {
        "type": "object",
        "description": "版本摘要；列表与详情共用",
        "properties": {
          "version": {
            "type": "string",
            "description": "版本号，同一蓝图内唯一"
          },
          "isLatest": {
            "type": "boolean",
            "description": "是否为当前最新版本"
          },
          "status": {
            "type": "string",
            "enum": [
              "available",
              "missing"
            ],
            "description": "产物是否完整可预览"
          },
          "publishSource": {
            "type": "string",
            "enum": [
              "mcp",
              "web",
              "web-cover"
            ],
            "description": "发布来源：mcp / 页内发布 / 页内覆盖"
          },
          "publishNote": {
            "type": "string",
            "description": "发布说明"
          },
          "deployedAt": {
            "type": "string",
            "format": "date-time",
            "description": "发布时间（ISO 8601）"
          },
          "artifactBytes": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "description": "产物字节数，未知为 null"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "version",
          "isLatest",
          "status",
          "publishSource",
          "publishNote",
          "deployedAt",
          "artifactBytes",
          "archivedAt"
        ],
        "additionalProperties": false
      }
    }
  } as const satisfies JsonSchema;

/** McpDeleteBlueprintVersionInput — schemas/mcp/delete-blueprint-version.json */
export const mcpDeleteBlueprintVersionSchema = {
    "$id": "mcp/delete-blueprint-version",
    "title": "McpDeleteBlueprintVersionInput",
    "description": "MCP 工具 youzhao_delete_blueprint_version 的入参：删除蓝图的一个版本",
    "type": "object",
    "properties": {
      "blueprintId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "蓝图 id，如 bp_xxx"
      },
      "version": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        "description": "要删除的版本号"
      },
      "idempotencyKey": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "description": "相同 key 的重复调用返回同一结果"
      }
    },
    "required": [
      "blueprintId",
      "version"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** McpGetBlueprintArtifactOutput — schemas/mcp/get-blueprint-artifact-output.json */
export const mcpGetBlueprintArtifactOutputSchema = {
    "$id": "mcp/get-blueprint-artifact-output",
    "title": "McpGetBlueprintArtifactOutput",
    "description": "MCP 工具 youzhao.get_blueprint_artifact 的返回结构：文本产物内联（text），HTML/多文件产物返回 files[] 清单与一次性入口票据（url/expiresAt）；不返回裸磁盘路径。",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "blueprintId": {
        "type": "string",
        "description": "蓝图 id"
      },
      "version": {
        "type": "string",
        "description": "版本号"
      },
      "entry": {
        "type": "string",
        "description": "入口文件名（相对产物根）"
      },
      "files": {
        "type": "array",
        "description": "产物文件清单（相对路径 + 字节数）",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "path": {
              "type": "string",
              "description": "相对产物根的路径"
            },
            "bytes": {
              "type": "integer",
              "minimum": 0,
              "description": "文件字节数"
            }
          },
          "required": [
            "path",
            "bytes"
          ]
        }
      },
      "text": {
        "type": "string",
        "description": "单文件文本产物的正文（仅 Markdown/HTML/文本且 ≤512 KiB 时内联）"
      },
      "url": {
        "type": "string",
        "description": "非内联产物的一次性入口票据 URL（60 秒内有效，单次使用）"
      },
      "expiresAt": {
        "type": "string",
        "description": "票据过期时间（ISO 8601）"
      }
    },
    "required": [
      "blueprintId",
      "version",
      "entry",
      "files"
    ]
  } as const satisfies JsonSchema;

/** McpGetBlueprintArtifactInput — schemas/mcp/get-blueprint-artifact.json */
export const mcpGetBlueprintArtifactSchema = {
    "$id": "mcp/get-blueprint-artifact",
    "title": "McpGetBlueprintArtifactInput",
    "description": "MCP 工具 youzhao_get_blueprint_artifact 的入参：读取一份蓝图版本的产物（HTML / Markdown）",
    "type": "object",
    "properties": {
      "blueprintId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "蓝图 id，如 bp_xxx"
      },
      "version": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "指定版本号；省略 = 读取最新版本的产物"
      }
    },
    "required": [
      "blueprintId"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** McpGetBlueprintOutput — schemas/mcp/get-blueprint-output.json */
export const mcpGetBlueprintOutputSchema = {
    "$id": "mcp/get-blueprint-output",
    "title": "McpGetBlueprintOutput",
    "description": "MCP 工具 youzhao.get_blueprint 的返回结构：单份蓝图元数据 + 版本列表。",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "blueprint": {
        "$ref": "#/$defs/BlueprintSummary"
      },
      "versions": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/BlueprintVersionSummary"
        },
        "description": "版本列表，按发布时间倒序"
      },
      "capabilities": {
        "type": "object",
        "description": "当前请求者对这一蓝图的操作能力，前端据此装配操作区（不按身份猜）",
        "properties": {
          "canManage": {
            "type": "boolean",
            "description": "可维护（改名、移动、归档、覆盖、归档版本）"
          },
          "canPublish": {
            "type": "boolean",
            "description": "可发布新版本"
          }
        },
        "required": [
          "canManage",
          "canPublish"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "blueprint",
      "versions",
      "capabilities"
    ],
    "$defs": {
      "BlueprintSummary": {
        "type": "object",
        "description": "蓝图卡片摘要；列表一次返回卡片所需全部字段（禁止前端 N+1 补拉，architecture-design §6.4）",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明蓝图 id，如 bp_xxx"
          },
          "name": {
            "type": "string",
            "description": "蓝图名称"
          },
          "summary": {
            "type": "string",
            "description": "概述"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "标签"
          },
          "groupId": {
            "type": "string",
            "description": "所属分组 id"
          },
          "groupName": {
            "type": "string",
            "description": "所属分组名（卡片上直接呈现，避免再查分组表）"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ],
            "description": "蓝图状态"
          },
          "versionCount": {
            "type": "integer",
            "minimum": 0,
            "description": "可用版本数量（不含已归档版本）"
          },
          "latestVersion": {
            "oneOf": [
              {
                "$ref": "#/$defs/BlueprintVersionSummary"
              },
              {
                "type": "null"
              }
            ],
            "description": "最新版本摘要；无任何版本时为 null"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "description": "最近更新时间（ISO 8601）"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "id",
          "name",
          "summary",
          "tags",
          "groupId",
          "groupName",
          "status",
          "versionCount",
          "latestVersion",
          "createdAt",
          "updatedAt",
          "archivedAt"
        ],
        "additionalProperties": false
      },
      "BlueprintVersionSummary": {
        "type": "object",
        "description": "版本摘要；列表与详情共用",
        "properties": {
          "version": {
            "type": "string",
            "description": "版本号，同一蓝图内唯一"
          },
          "isLatest": {
            "type": "boolean",
            "description": "是否为当前最新版本"
          },
          "status": {
            "type": "string",
            "enum": [
              "available",
              "missing"
            ],
            "description": "产物是否完整可预览"
          },
          "publishSource": {
            "type": "string",
            "enum": [
              "mcp",
              "web",
              "web-cover"
            ],
            "description": "发布来源：mcp / 页内发布 / 页内覆盖"
          },
          "publishNote": {
            "type": "string",
            "description": "发布说明"
          },
          "deployedAt": {
            "type": "string",
            "format": "date-time",
            "description": "发布时间（ISO 8601）"
          },
          "artifactBytes": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "description": "产物字节数，未知为 null"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "version",
          "isLatest",
          "status",
          "publishSource",
          "publishNote",
          "deployedAt",
          "artifactBytes",
          "archivedAt"
        ],
        "additionalProperties": false
      }
    }
  } as const satisfies JsonSchema;

/** McpGetBlueprintInput — schemas/mcp/get-blueprint.json */
export const mcpGetBlueprintSchema = {
    "$id": "mcp/get-blueprint",
    "title": "McpGetBlueprintInput",
    "description": "MCP 工具 youzhao_get_blueprint 的入参：读取一份蓝图的元数据与版本列表",
    "type": "object",
    "properties": {
      "blueprintId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "蓝图 id，如 bp_xxx"
      },
      "version": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "指定版本号；省略 = 返回最新版本的元数据"
      }
    },
    "required": [
      "blueprintId"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** McpListBlueprintGroupsOutput — schemas/mcp/list-blueprint-groups-output.json */
export const mcpListBlueprintGroupsOutputSchema = {
    "$id": "mcp/list-blueprint-groups-output",
    "title": "McpListBlueprintGroupsOutput",
    "description": "MCP 工具 youzhao.list_blueprint_groups 的返回结构：绑定用户可见的分组。",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "groups": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/BlueprintGroupSummary"
        },
        "description": "可见分组列表"
      }
    },
    "required": [
      "groups"
    ],
    "$defs": {
      "BlueprintGroupSummary": {
        "type": "object",
        "description": "分组摘要",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明分组 id，如 grp_xxx"
          },
          "name": {
            "type": "string",
            "description": "分组名，全局唯一"
          },
          "isDefault": {
            "type": "boolean",
            "description": "是否默认分组（不可归档、恒首位）"
          },
          "sortOrder": {
            "type": "integer",
            "minimum": 0,
            "description": "排序序号，越小越靠前"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间（ISO 8601）；null = 未归档"
          },
          "blueprintCount": {
            "type": "integer",
            "minimum": 0,
            "description": "该分组下可见蓝图数量（卡片数与区头计数同源）"
          }
        },
        "required": [
          "id",
          "name",
          "isDefault",
          "sortOrder",
          "archivedAt",
          "blueprintCount"
        ],
        "additionalProperties": false
      }
    }
  } as const satisfies JsonSchema;

/** McpListBlueprintGroupsInput — schemas/mcp/list-blueprint-groups.json */
export const mcpListBlueprintGroupsSchema = {
    "$id": "mcp/list-blueprint-groups",
    "title": "McpListBlueprintGroupsInput",
    "description": "MCP 工具 youzhao_list_blueprint_groups 的入参：列出 Token 授权范围内的蓝图分组；该工具不需要任何参数",
    "type": "object",
    "properties": {},
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** McpListBlueprintsOutput — schemas/mcp/list-blueprints-output.json */
export const mcpListBlueprintsOutputSchema = {
    "$id": "mcp/list-blueprints-output",
    "title": "McpListBlueprintsOutput",
    "description": "MCP 工具 youzhao.list_blueprints 的返回结构：分页后的可见蓝图。",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/BlueprintSummary"
        },
        "description": "当前页蓝图卡片"
      },
      "groups": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "description": "分组 id"
            },
            "name": {
              "type": "string",
              "description": "分组名"
            },
            "isDefault": {
              "type": "boolean",
              "description": "是否默认分组"
            },
            "sortOrder": {
              "type": "integer",
              "minimum": 0,
              "description": "排序序号"
            },
            "blueprintCount": {
              "type": "integer",
              "minimum": 0,
              "description": "分组内蓝图数"
            }
          },
          "required": [
            "id",
            "name",
            "isDefault",
            "sortOrder",
            "blueprintCount"
          ],
          "additionalProperties": false
        },
        "description": "全部分组（含空分组，供拖拽落位；默认分组恒首位）"
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "description": "当前页码（从 1 开始）"
      },
      "pageSize": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100,
        "description": "每页条数"
      },
      "total": {
        "type": "integer",
        "minimum": 0,
        "description": "命中的蓝图总数（用于翻页判断）"
      }
    },
    "required": [
      "items",
      "groups",
      "page",
      "pageSize",
      "total"
    ],
    "$defs": {
      "BlueprintVersionSummary": {
        "type": "object",
        "description": "版本摘要；列表与详情共用",
        "properties": {
          "version": {
            "type": "string",
            "description": "版本号，同一蓝图内唯一"
          },
          "isLatest": {
            "type": "boolean",
            "description": "是否为当前最新版本"
          },
          "status": {
            "type": "string",
            "enum": [
              "available",
              "missing"
            ],
            "description": "产物是否完整可预览"
          },
          "publishSource": {
            "type": "string",
            "enum": [
              "mcp",
              "web",
              "web-cover"
            ],
            "description": "发布来源：mcp / 页内发布 / 页内覆盖"
          },
          "publishNote": {
            "type": "string",
            "description": "发布说明"
          },
          "deployedAt": {
            "type": "string",
            "format": "date-time",
            "description": "发布时间（ISO 8601）"
          },
          "artifactBytes": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "description": "产物字节数，未知为 null"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "version",
          "isLatest",
          "status",
          "publishSource",
          "publishNote",
          "deployedAt",
          "artifactBytes",
          "archivedAt"
        ],
        "additionalProperties": false
      },
      "BlueprintSummary": {
        "type": "object",
        "description": "蓝图卡片摘要；列表一次返回卡片所需全部字段（禁止前端 N+1 补拉，architecture-design §6.4）",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明蓝图 id，如 bp_xxx"
          },
          "name": {
            "type": "string",
            "description": "蓝图名称"
          },
          "summary": {
            "type": "string",
            "description": "概述"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "标签"
          },
          "groupId": {
            "type": "string",
            "description": "所属分组 id"
          },
          "groupName": {
            "type": "string",
            "description": "所属分组名（卡片上直接呈现，避免再查分组表）"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ],
            "description": "蓝图状态"
          },
          "versionCount": {
            "type": "integer",
            "minimum": 0,
            "description": "可用版本数量（不含已归档版本）"
          },
          "latestVersion": {
            "oneOf": [
              {
                "$ref": "#/$defs/BlueprintVersionSummary"
              },
              {
                "type": "null"
              }
            ],
            "description": "最新版本摘要；无任何版本时为 null"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "description": "最近更新时间（ISO 8601）"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "id",
          "name",
          "summary",
          "tags",
          "groupId",
          "groupName",
          "status",
          "versionCount",
          "latestVersion",
          "createdAt",
          "updatedAt",
          "archivedAt"
        ],
        "additionalProperties": false
      }
    }
  } as const satisfies JsonSchema;

/** McpListBlueprintsInput — schemas/mcp/list-blueprints.json */
export const mcpListBlueprintsSchema = {
    "$id": "mcp/list-blueprints",
    "title": "McpListBlueprintsInput",
    "description": "MCP 工具 youzhao_list_blueprints 的入参：分页列出 Token 授权范围内的蓝图；全部字段可选",
    "type": "object",
    "properties": {
      "keyword": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120,
        "description": "名称/概述关键词，模糊匹配"
      },
      "groupId": {
        "type": "string",
        "description": "只返回该分组下的蓝图；省略 = 不限分组"
      },
      "status": {
        "type": "string",
        "enum": [
          "active",
          "archived"
        ],
        "description": "按蓝图状态过滤；省略 = 默认只看 active"
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "description": "页码，从 1 开始"
      },
      "pageSize": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100,
        "description": "每页条数，默认 20，上限 100"
      }
    },
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** McpPublishBlueprintOutput — schemas/mcp/publish-blueprint-output.json */
export const mcpPublishBlueprintOutputSchema = {
    "$id": "mcp/publish-blueprint-output",
    "title": "McpPublishBlueprintOutput",
    "description": "MCP 工具 youzhao.publish_blueprint 的返回结构：蓝图与本次发布的版本。",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "blueprint": {
        "$ref": "#/$defs/BlueprintSummary"
      },
      "version": {
        "oneOf": [
          {
            "$ref": "#/$defs/BlueprintVersionSummary"
          },
          {
            "type": "null"
          }
        ],
        "description": "本次操作涉及的版本；归档/恢复蓝图时为 null"
      }
    },
    "required": [
      "blueprint",
      "version"
    ],
    "$defs": {
      "BlueprintSummary": {
        "type": "object",
        "description": "蓝图卡片摘要；列表一次返回卡片所需全部字段（禁止前端 N+1 补拉，architecture-design §6.4）",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明蓝图 id，如 bp_xxx"
          },
          "name": {
            "type": "string",
            "description": "蓝图名称"
          },
          "summary": {
            "type": "string",
            "description": "概述"
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "标签"
          },
          "groupId": {
            "type": "string",
            "description": "所属分组 id"
          },
          "groupName": {
            "type": "string",
            "description": "所属分组名（卡片上直接呈现，避免再查分组表）"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "archived"
            ],
            "description": "蓝图状态"
          },
          "versionCount": {
            "type": "integer",
            "minimum": 0,
            "description": "可用版本数量（不含已归档版本）"
          },
          "latestVersion": {
            "oneOf": [
              {
                "$ref": "#/$defs/BlueprintVersionSummary"
              },
              {
                "type": "null"
              }
            ],
            "description": "最新版本摘要；无任何版本时为 null"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "description": "最近更新时间（ISO 8601）"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "id",
          "name",
          "summary",
          "tags",
          "groupId",
          "groupName",
          "status",
          "versionCount",
          "latestVersion",
          "createdAt",
          "updatedAt",
          "archivedAt"
        ],
        "additionalProperties": false
      },
      "BlueprintVersionSummary": {
        "type": "object",
        "description": "版本摘要；列表与详情共用",
        "properties": {
          "version": {
            "type": "string",
            "description": "版本号，同一蓝图内唯一"
          },
          "isLatest": {
            "type": "boolean",
            "description": "是否为当前最新版本"
          },
          "status": {
            "type": "string",
            "enum": [
              "available",
              "missing"
            ],
            "description": "产物是否完整可预览"
          },
          "publishSource": {
            "type": "string",
            "enum": [
              "mcp",
              "web",
              "web-cover"
            ],
            "description": "发布来源：mcp / 页内发布 / 页内覆盖"
          },
          "publishNote": {
            "type": "string",
            "description": "发布说明"
          },
          "deployedAt": {
            "type": "string",
            "format": "date-time",
            "description": "发布时间（ISO 8601）"
          },
          "artifactBytes": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 0,
            "description": "产物字节数，未知为 null"
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "归档时间；null = 未归档"
          }
        },
        "required": [
          "version",
          "isLatest",
          "status",
          "publishSource",
          "publishNote",
          "deployedAt",
          "artifactBytes",
          "archivedAt"
        ],
        "additionalProperties": false
      }
    }
  } as const satisfies JsonSchema;

/** McpPublishBlueprintInput — schemas/mcp/publish-blueprint.json */
export const mcpPublishBlueprintSchema = {
    "$id": "mcp/publish-blueprint",
    "title": "McpPublishBlueprintInput",
    "description": "MCP 工具 youzhao_publish_blueprint 的入参：发布一次蓝图产物；不带 blueprintId 即新建蓝图，带 blueprintId 即在该蓝图上发布新版本",
    "type": "object",
    "properties": {
      "blueprintId": {
        "type": "string",
        "minLength": 1,
        "description": "省略 = 新建蓝图，提供 = 在该蓝图上发布新版本"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120,
        "description": "蓝图名称"
      },
      "summary": {
        "type": "string",
        "maxLength": 500,
        "description": "概述"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 32
        },
        "description": "标签，每项 1..32 字符"
      },
      "groupId": {
        "type": "string",
        "description": "所属分组 id"
      },
      "version": {
        "type": "string",
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
        "description": "版本号，同一蓝图内唯一"
      },
      "html": {
        "type": "string",
        "description": "产物入口 HTML 文本"
      },
      "markdown": {
        "type": "string",
        "description": "产物配套 Markdown"
      },
      "publishNote": {
        "type": "string",
        "maxLength": 500,
        "description": "发布说明"
      },
      "idempotencyKey": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "description": "相同 key 的重复调用返回同一结果"
      }
    },
    "required": [
      "name",
      "groupId",
      "version",
      "html"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** ChangeOwnPasswordRequest — schemas/me/password.json */
export const mePasswordSchema = {
    "$id": "me/password",
    "title": "ChangeOwnPasswordRequest",
    "description": "POST /api/me/password 请求体（docs/permission-design.md §6.2 本人自助）：本人修改密码，需校验原密码",
    "type": "object",
    "properties": {
      "oldPassword": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256,
        "description": "当前密码"
      },
      "newPassword": {
        "type": "string",
        "minLength": 8,
        "maxLength": 256,
        "description": "新密码（至少 8 位）"
      }
    },
    "required": [
      "oldPassword",
      "newPassword"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** UpdateMeRequest — schemas/me/update.json */
export const meUpdateSchema = {
    "$id": "me/update",
    "title": "UpdateMeRequest",
    "description": "PATCH /api/me 请求体（docs/permission-design.md §6.2 本人自助）：只改本人资料；身份、状态、权限字段被 additionalProperties:false 拒绝",
    "type": "object",
    "properties": {
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "姓名"
      },
      "email": {
        "type": "string",
        "description": "邮箱，可留空字符串"
      },
      "phone": {
        "type": "string",
        "description": "手机号，可留空字符串"
      }
    },
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** PreviewTicketResponse — schemas/preview/ticket-response.json */
export const previewTicketResponseSchema = {
    "$id": "preview/ticket-response",
    "title": "PreviewTicketResponse",
    "description": "预览票据响应（docs/architecture-design.md §3.7）：票据原文只在此处出现一次，服务端只存哈希；换票地址由服务端生成，前端不得自行拼接",
    "type": "object",
    "$defs": {
      "PreviewTicket": {
        "type": "object",
        "description": "一次性票据内容；同一票据无法二次换票",
        "required": [
          "ticket",
          "expiresAt",
          "url",
          "blueprintId",
          "version",
          "purpose"
        ],
        "properties": {
          "ticket": {
            "type": "string",
            "minLength": 1,
            "description": "一次性票据原文（yz_pt_…），只在本次响应中出现，立即随换票地址使用"
          },
          "expiresAt": {
            "type": "string",
            "format": "date-time",
            "description": "票据过期时间（默认 60s）"
          },
          "url": {
            "type": "string",
            "minLength": 1,
            "description": "换票地址（预览域 /preview/p/{blueprintId}/{version}/?t=…），由服务端生成"
          },
          "blueprintId": {
            "type": "string",
            "minLength": 1,
            "description": "票据绑定的蓝图；换票时与请求路径不一致即拒绝"
          },
          "version": {
            "type": "string",
            "minLength": 1,
            "description": "票据绑定的版本"
          },
          "purpose": {
            "type": "string",
            "enum": [
              "preview",
              "embed"
            ],
            "description": "preview=工作台内预览（需查看权）；embed=嵌入换票（需共享密钥）"
          }
        },
        "additionalProperties": false
      }
    },
    "properties": {
      "data": {
        "$ref": "#/$defs/PreviewTicket"
      },
      "meta": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string",
            "minLength": 1,
            "description": "请求 id，用于日志追溯"
          }
        },
        "required": [
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** PreviewTicketRequest — schemas/preview/ticket.json */
export const previewTicketSchema = {
    "$id": "preview/ticket",
    "title": "PreviewTicketRequest",
    "description": "POST /api/preview-tickets 请求体（docs/architecture-design.md §3.7）：申请一次性预览票据，用于换取预览域受限 Cookie",
    "type": "object",
    "required": [
      "blueprintId",
      "purpose"
    ],
    "properties": {
      "blueprintId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "目标蓝图 id"
      },
      "version": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "省略时取该蓝图最新的未归档版本"
      },
      "purpose": {
        "type": "string",
        "enum": [
          "preview",
          "embed"
        ],
        "description": "preview=工作台内预览（需查看权）；embed=嵌入场景（需嵌入共享密钥）"
      }
    },
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** HealthResponse — schemas/system/health.json */
export const systemHealthSchema = {
    "$id": "system/health",
    "title": "HealthResponse",
    "description": "健康检查响应（docs/architecture-design.md §3.8、docs/deployment-rules.md §12）",
    "type": "object",
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "status": {
            "type": "string",
            "enum": [
              "ok",
              "degraded"
            ]
          },
          "time": {
            "type": "string",
            "description": "ISO 8601 时间戳"
          },
          "contractVersion": {
            "type": "string",
            "description": "契约包版本，用于排查前后端契约错位（§6.1 规则 3）"
          },
          "services": {
            "type": "object",
            "properties": {
              "database": {
                "type": "string",
                "enum": [
                  "up",
                  "down"
                ]
              }
            },
            "required": [
              "database"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "status",
          "time",
          "contractVersion",
          "services"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string"
          }
        },
        "required": [
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** CreateMcpTokenResponse — schemas/tokens/create-response.json */
export const tokensCreateResponseSchema = {
    "$id": "tokens/create-response",
    "title": "CreateMcpTokenResponse",
    "description": "POST /api/tokens 响应：与列表摘要同字段，外加明文令牌。明文令牌只在此响应出现一次，服务端不保存、之后无法再取",
    "type": "object",
    "properties": {
      "data": {
        "type": "object",
        "description": "新建成的 MCP Token：摘要字段 + 明文令牌（本文件内展开，因生成器不支持跨文件 $ref）",
        "properties": {
          "token": {
            "type": "string",
            "description": "明文令牌只在此响应出现一次，请立即保存；服务端仅保存摘要"
          },
          "id": {
            "type": "string",
            "description": "不透明 Token id，如 tok_xxx"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "description": "Token 名称"
          },
          "tokenPrefix": {
            "type": "string",
            "description": "明文令牌前缀，仅用于辨认，不可用于鉴权"
          },
          "scopes": {
            "type": "array",
            "minItems": 1,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "enum": [
                "read:blueprint",
                "publish:blueprint"
              ]
            },
            "description": "授权范围；Token 能力 = 绑定用户能力 ∩ scope"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "disabled"
            ],
            "description": "Token 状态；disabled 后该 Token 立即不可用"
          },
          "boundUserId": {
            "type": "string",
            "description": "绑定用户 id：Token 以该用户的身份与权限调用"
          },
          "boundUserDisplayName": {
            "type": "string",
            "description": "绑定用户姓名"
          },
          "createdByUserId": {
            "type": "string",
            "description": "创建者用户 id"
          },
          "createdByDisplayName": {
            "type": "string",
            "description": "创建者姓名"
          },
          "expiresAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "过期时间（ISO 8601）；null = 永不过期"
          },
          "lastUsedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "最近一次使用时间（ISO 8601）；null = 从未使用"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          }
        },
        "required": [
          "token",
          "id",
          "name",
          "tokenPrefix",
          "scopes",
          "status",
          "boundUserId",
          "boundUserDisplayName",
          "createdByUserId",
          "createdByDisplayName",
          "expiresAt",
          "lastUsedAt",
          "createdAt"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string",
            "description": "请求 id"
          }
        },
        "required": [
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** CreateMcpTokenRequest — schemas/tokens/create.json */
export const tokensCreateSchema = {
    "$id": "tokens/create",
    "title": "CreateMcpTokenRequest",
    "description": "POST /api/tokens 请求体：创建 MCP Token；明文令牌只在创建响应中出现一次",
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80,
        "description": "Token 名称，用于在列表中辨识"
      },
      "scopes": {
        "type": "array",
        "minItems": 1,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "enum": [
            "read:blueprint",
            "publish:blueprint"
          ]
        },
        "description": "申请的能力范围；Token 能力 = 绑定用户能力 ∩ scope，交集之外的操作一律拒绝"
      },
      "expiresAt": {
        "type": "string",
        "format": "date-time",
        "description": "过期时间（ISO 8601）；省略 = 永不过期"
      },
      "bindUserId": {
        "type": "string",
        "description": "仅平台所有者可传，用于替他人创建；其他人传了会被拒绝"
      }
    },
    "required": [
      "name",
      "scopes"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** TokensListResponse — schemas/tokens/list.json */
export const tokensListSchema = {
    "$id": "tokens/list",
    "title": "TokensListResponse",
    "description": "GET /api/tokens 响应：当前调用者可见的 MCP Token 列表（平台所有者可见全平台；其他人只可见自己创建或绑定给自己的 Token）",
    "type": "object",
    "$defs": {
      "McpTokenSummary": {
        "type": "object",
        "description": "MCP Token 摘要；列表须自带呈现与行操作所需的全部字段（architecture-design §6.4），明文令牌永不在此出现",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明 Token id，如 tok_xxx"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "description": "Token 名称"
          },
          "tokenPrefix": {
            "type": "string",
            "description": "明文令牌前缀，仅用于辨认，不可用于鉴权"
          },
          "scopes": {
            "type": "array",
            "minItems": 1,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "enum": [
                "read:blueprint",
                "publish:blueprint"
              ]
            },
            "description": "授权范围；Token 能力 = 绑定用户能力 ∩ scope"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "disabled"
            ],
            "description": "Token 状态；disabled 后该 Token 立即不可用"
          },
          "boundUserId": {
            "type": "string",
            "description": "绑定用户 id：Token 以该用户的身份与权限调用"
          },
          "boundUserDisplayName": {
            "type": "string",
            "description": "绑定用户姓名（列表直接呈现，避免再查用户表）"
          },
          "createdByUserId": {
            "type": "string",
            "description": "创建者用户 id"
          },
          "createdByDisplayName": {
            "type": "string",
            "description": "创建者姓名"
          },
          "expiresAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "过期时间（ISO 8601）；null = 永不过期"
          },
          "lastUsedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "最近一次使用时间（ISO 8601）；null = 从未使用"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          }
        },
        "required": [
          "id",
          "name",
          "tokenPrefix",
          "scopes",
          "status",
          "boundUserId",
          "boundUserDisplayName",
          "createdByUserId",
          "createdByDisplayName",
          "expiresAt",
          "lastUsedAt",
          "createdAt"
        ],
        "additionalProperties": false
      }
    },
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/McpTokenSummary"
            },
            "description": "当前页 Token 列表"
          }
        },
        "required": [
          "items"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "page": {
            "type": "integer",
            "minimum": 1,
            "description": "当前页码，从 1 开始"
          },
          "pageSize": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "description": "每页条数，默认 20，上限 100"
          },
          "total": {
            "type": "integer",
            "minimum": 0,
            "description": "过滤后的总条数"
          },
          "requestId": {
            "type": "string",
            "description": "请求 id，用于日志追溯"
          }
        },
        "required": [
          "page",
          "pageSize",
          "total",
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** McpTokenMutationResponse — schemas/tokens/mutation.json */
export const tokensMutationSchema = {
    "$id": "tokens/mutation",
    "title": "McpTokenMutationResponse",
    "description": "MCP Token 写操作（改名 / 启停 / 删除）的统一响应：返回被改动 Token 的当前状态",
    "type": "object",
    "properties": {
      "data": {
        "$ref": "#/$defs/McpTokenSummary"
      },
      "meta": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string",
            "description": "请求 id"
          }
        },
        "required": [
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false,
    "$defs": {
      "McpTokenSummary": {
        "type": "object",
        "description": "MCP Token 摘要；明文令牌永不在此出现",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明 Token id，如 tok_xxx"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "description": "Token 名称"
          },
          "tokenPrefix": {
            "type": "string",
            "description": "明文令牌前缀，仅用于辨认，不可用于鉴权"
          },
          "scopes": {
            "type": "array",
            "minItems": 1,
            "uniqueItems": true,
            "items": {
              "type": "string",
              "enum": [
                "read:blueprint",
                "publish:blueprint"
              ]
            },
            "description": "授权范围；Token 能力 = 绑定用户能力 ∩ scope"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "disabled"
            ],
            "description": "Token 状态；disabled 后该 Token 立即不可用"
          },
          "boundUserId": {
            "type": "string",
            "description": "绑定用户 id：Token 以该用户的身份与权限调用"
          },
          "boundUserDisplayName": {
            "type": "string",
            "description": "绑定用户姓名"
          },
          "createdByUserId": {
            "type": "string",
            "description": "创建者用户 id"
          },
          "createdByDisplayName": {
            "type": "string",
            "description": "创建者姓名"
          },
          "expiresAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "过期时间（ISO 8601）；null = 永不过期"
          },
          "lastUsedAt": {
            "type": [
              "string",
              "null"
            ],
            "format": "date-time",
            "description": "最近一次使用时间（ISO 8601）；null = 从未使用"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          }
        },
        "required": [
          "id",
          "name",
          "tokenPrefix",
          "scopes",
          "status",
          "boundUserId",
          "boundUserDisplayName",
          "createdByUserId",
          "createdByDisplayName",
          "expiresAt",
          "lastUsedAt",
          "createdAt"
        ],
        "additionalProperties": false
      }
    }
  } as const satisfies JsonSchema;

/** UpdateMcpTokenRequest — schemas/tokens/update.json */
export const tokensUpdateSchema = {
    "$id": "tokens/update",
    "title": "UpdateMcpTokenRequest",
    "description": "PATCH /api/tokens/:id 请求体：只允许改名与启停，不允许改绑定用户与 scope（要改只能重新创建）",
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80,
        "description": "新名称"
      },
      "status": {
        "type": "string",
        "enum": [
          "active",
          "disabled"
        ],
        "description": "启停：disabled 后该 Token 立即不可用，可再置回 active"
      }
    },
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** VerifyMcpTokenResponse — schemas/tokens/verify-response.json */
export const tokensVerifyResponseSchema = {
    "$id": "tokens/verify-response",
    "title": "VerifyMcpTokenResponse",
    "description": "POST /api/mcp-tokens/verify 响应：环回调用本进程 /mcp 的 initialize + tools/list 得到的自检结果",
    "type": "object",
    "properties": {
      "data": {
        "type": "object",
        "description": "自检结果（失败时走错误信封，因此成功响应里 ok 恒为 true）",
        "properties": {
          "ok": {
            "type": "boolean"
          },
          "tokenId": {
            "type": "string"
          },
          "tokenPrefix": {
            "type": "string",
            "description": "展示用前缀，与 Token 列表一致"
          },
          "scopes": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "read:blueprint",
                "publish:blueprint"
              ]
            }
          },
          "serverInfo": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string"
              },
              "version": {
                "type": "string"
              }
            },
            "required": [
              "name",
              "version"
            ],
            "additionalProperties": false
          },
          "protocolVersion": {
            "type": "string",
            "description": "握手（legacy）时代协商出的协议版本"
          },
          "toolCount": {
            "type": "integer",
            "minimum": 0
          },
          "tools": {
            "type": "array",
            "description": "该 Token 的 scope 过滤后，客户端实际会看到的工具",
            "items": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string"
                },
                "title": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "scope": {
                  "type": "string",
                  "enum": [
                    "read:blueprint",
                    "publish:blueprint"
                  ]
                }
              },
              "required": [
                "name",
                "title",
                "scope"
              ],
              "additionalProperties": false
            }
          },
          "latencyMs": {
            "type": "integer",
            "minimum": 0
          }
        },
        "required": [
          "ok",
          "tokenId",
          "tokenPrefix",
          "scopes",
          "serverInfo",
          "protocolVersion",
          "toolCount",
          "tools",
          "latencyMs"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "requestId": {
            "type": "string"
          }
        },
        "required": [
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** VerifyMcpTokenRequest — schemas/tokens/verify.json */
export const tokensVerifySchema = {
    "$id": "tokens/verify",
    "title": "VerifyMcpTokenRequest",
    "description": "POST /api/mcp-tokens/verify 请求体：自检一个 MCP Token 是否可用；明文由客户端提交，库里只存哈希、服务端无法反推",
    "type": "object",
    "properties": {
      "token": {
        "type": "string",
        "minLength": 1,
        "maxLength": 300,
        "description": "创建时展示过一次的明文 Token（yz_mcp_<tokenId>_<secret>）"
      }
    },
    "required": [
      "token"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** SetUserCapabilitiesRequest — schemas/users/capabilities.json */
export const usersCapabilitiesSchema = {
    "$id": "users/capabilities",
    "title": "SetUserCapabilitiesRequest",
    "description": "PUT /api/users/:id/capabilities 请求体（仅所有者，docs/permission-design.md §6.2）：整体设置业务能力与资源范围；能力必须显式带范围",
    "type": "object",
    "$defs": {
      "CapabilityGrant": {
        "type": "object",
        "description": "一条业务能力及其资源范围",
        "properties": {
          "capability": {
            "type": "string",
            "enum": [
              "blueprint.manage",
              "blueprint.publish"
            ],
            "description": "业务能力"
          },
          "targetType": {
            "type": "string",
            "enum": [
              "group",
              "blueprint"
            ],
            "description": "目标资源类型"
          },
          "targetId": {
            "type": "string",
            "minLength": 1,
            "description": "目标资源 id"
          }
        },
        "required": [
          "capability",
          "targetType",
          "targetId"
        ],
        "additionalProperties": false
      }
    },
    "properties": {
      "capabilities": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/CapabilityGrant"
        },
        "description": "完整的能力集合，整体替换旧集合；空数组 = 收回全部业务能力"
      }
    },
    "required": [
      "capabilities"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** CreateUserRequest — schemas/users/create.json */
export const usersCreateSchema = {
    "$id": "users/create",
    "title": "CreateUserRequest",
    "description": "POST /api/users 请求体（docs/permission-design.md §6.2）：所有者可指定身份与归属；用户管理员只能创建 member，且自动归自己",
    "type": "object",
    "$defs": {
      "ViewGrantTarget": {
        "type": "object",
        "description": "一条查看授权的目标资源",
        "properties": {
          "targetType": {
            "type": "string",
            "enum": [
              "group",
              "blueprint"
            ],
            "description": "目标资源类型"
          },
          "targetId": {
            "type": "string",
            "minLength": 1,
            "description": "目标资源 id"
          }
        },
        "required": [
          "targetType",
          "targetId"
        ],
        "additionalProperties": false
      }
    },
    "properties": {
      "username": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "登录名，全局唯一"
      },
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "姓名"
      },
      "email": {
        "type": "string",
        "description": "邮箱，可留空字符串"
      },
      "phone": {
        "type": "string",
        "description": "手机号，可留空字符串"
      },
      "password": {
        "type": "string",
        "minLength": 8,
        "maxLength": 256,
        "description": "初始密码（一次性），首登强制修改"
      },
      "viewGrants": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/ViewGrantTarget"
        },
        "description": "可选：初始查看授权，不得超过操作者的可委派范围"
      },
      "managedByUserIds": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true,
        "description": "可选：管理归属（仅所有者可传；用户管理员创建的成员自动归自己）"
      }
    },
    "required": [
      "username",
      "displayName",
      "password"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** UserGrantsChangeRequest — schemas/users/grants-change.json */
export const usersGrantsChangeSchema = {
    "$id": "users/grants-change",
    "title": "UserGrantsChangeRequest",
    "description": "POST /api/users/:id/grants 请求体（docs/permission-design.md §6.2）：增量授予 / 撤销查看权；服务端只接受差异，拒绝整表替换（不变量 5）",
    "type": "object",
    "$defs": {
      "GrantTarget": {
        "type": "object",
        "description": "一条待增删的查看授权目标",
        "properties": {
          "targetType": {
            "type": "string",
            "enum": [
              "group",
              "blueprint"
            ],
            "description": "目标资源类型"
          },
          "targetId": {
            "type": "string",
            "minLength": 1,
            "description": "目标资源 id"
          }
        },
        "required": [
          "targetType",
          "targetId"
        ],
        "additionalProperties": false
      }
    },
    "properties": {
      "add": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/GrantTarget"
        },
        "description": "新增的查看授权，必须落在操作者的可委派范围内"
      },
      "remove": {
        "type": "array",
        "items": {
          "$ref": "#/$defs/GrantTarget"
        },
        "description": "撤销的查看授权"
      }
    },
    "anyOf": [
      {
        "required": [
          "add"
        ],
        "properties": {
          "add": {
            "type": "array",
            "minItems": 1
          }
        }
      },
      {
        "required": [
          "remove"
        ],
        "properties": {
          "remove": {
            "type": "array",
            "minItems": 1
          }
        }
      }
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** UserGrantsResponse — schemas/users/grants.json */
export const usersGrantsSchema = {
    "$id": "users/grants",
    "title": "UserGrantsResponse",
    "description": "GET /api/users/:id/grants 响应（docs/permission-design.md §6.2）：列出某用户已有的查看授权及来源；本人查看自己的范围走 GET /api/me",
    "type": "object",
    "$defs": {
      "ViewGrantItem": {
        "type": "object",
        "description": "一条已有查看授权",
        "properties": {
          "targetType": {
            "type": "string",
            "enum": [
              "group",
              "blueprint"
            ],
            "description": "目标资源类型"
          },
          "targetId": {
            "type": "string",
            "description": "目标资源 id"
          },
          "grantedByUserId": {
            "type": "string",
            "description": "授予者的用户 id"
          },
          "grantedByDisplayName": {
            "type": "string",
            "description": "授予者姓名，供列表直接展示"
          },
          "grantedAt": {
            "type": "string",
            "format": "date-time",
            "description": "授予时间（ISO 8601）"
          }
        },
        "required": [
          "targetType",
          "targetId",
          "grantedByUserId",
          "grantedByDisplayName",
          "grantedAt"
        ],
        "additionalProperties": false
      }
    },
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/ViewGrantItem"
            },
            "description": "当前页查看授权列表"
          }
        },
        "required": [
          "items"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "page": {
            "type": "integer",
            "minimum": 1,
            "description": "当前页码，从 1 开始"
          },
          "pageSize": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "description": "每页条数，默认 20，上限 100"
          },
          "total": {
            "type": "integer",
            "minimum": 0,
            "description": "过滤后的总条数"
          },
          "requestId": {
            "type": "string",
            "description": "请求 id，用于日志追溯"
          }
        },
        "required": [
          "page",
          "pageSize",
          "total",
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** SetUserIdentityRequest — schemas/users/identity.json */
export const usersIdentitySchema = {
    "$id": "users/identity",
    "title": "SetUserIdentityRequest",
    "description": "PUT /api/users/:id/identity 请求体（仅所有者，docs/permission-design.md §6.2）：任命 / 撤销用户管理员；owner 不能经此接口设定",
    "type": "object",
    "properties": {
      "identity": {
        "type": "string",
        "enum": [
          "member",
          "user_admin"
        ],
        "description": "目标身份；owner 只能由初始化或运维变更产生"
      }
    },
    "required": [
      "identity"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** UsersListResponse — schemas/users/list.json */
export const usersListSchema = {
    "$id": "users/list",
    "title": "UsersListResponse",
    "description": "GET /api/users 响应（docs/permission-design.md §6.2）：所有者返回全平台用户，用户管理员只返回自己管理的普通用户",
    "type": "object",
    "$defs": {
      "UserSummary": {
        "type": "object",
        "description": "列表行的用户摘要；列表须自带呈现与行操作所需的全部字段（architecture-design §6.4）",
        "properties": {
          "id": {
            "type": "string",
            "description": "不透明用户 id，如 usr_xxx"
          },
          "username": {
            "type": "string",
            "description": "登录名，全局唯一"
          },
          "displayName": {
            "type": "string",
            "description": "姓名"
          },
          "email": {
            "type": [
              "string",
              "null"
            ],
            "description": "邮箱，未填为 null"
          },
          "phone": {
            "type": [
              "string",
              "null"
            ],
            "description": "手机号，未填为 null"
          },
          "status": {
            "type": "string",
            "enum": [
              "active",
              "disabled"
            ],
            "description": "账号状态；disabled 即会话与 MCP Token 均已失效"
          },
          "identity": {
            "type": "string",
            "enum": [
              "owner",
              "user_admin",
              "member"
            ],
            "description": "互斥身份（owner 全库唯一）"
          },
          "managedByUserIds": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "description": "管理归属：可含多位用户管理员；空数组 = 暂未指派"
          },
          "createdAt": {
            "type": "string",
            "format": "date-time",
            "description": "创建时间（ISO 8601）"
          },
          "updatedAt": {
            "type": "string",
            "format": "date-time",
            "description": "最近更新时间（ISO 8601）"
          }
        },
        "required": [
          "id",
          "username",
          "displayName",
          "email",
          "phone",
          "status",
          "identity",
          "managedByUserIds",
          "createdAt",
          "updatedAt"
        ],
        "additionalProperties": false
      }
    },
    "properties": {
      "data": {
        "type": "object",
        "properties": {
          "items": {
            "type": "array",
            "items": {
              "$ref": "#/$defs/UserSummary"
            },
            "description": "当前页用户列表"
          }
        },
        "required": [
          "items"
        ],
        "additionalProperties": false
      },
      "meta": {
        "type": "object",
        "properties": {
          "page": {
            "type": "integer",
            "minimum": 1,
            "description": "当前页码，从 1 开始"
          },
          "pageSize": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100,
            "description": "每页条数，默认 20，上限 100"
          },
          "total": {
            "type": "integer",
            "minimum": 0,
            "description": "过滤后的总条数"
          },
          "requestId": {
            "type": "string",
            "description": "请求 id，用于日志追溯"
          }
        },
        "required": [
          "page",
          "pageSize",
          "total",
          "requestId"
        ],
        "additionalProperties": false
      }
    },
    "required": [
      "data",
      "meta"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** SetManagedByRequest — schemas/users/managed-by.json */
export const usersManagedBySchema = {
    "$id": "users/managed-by",
    "title": "SetManagedByRequest",
    "description": "PUT /api/users/:id/managed-by 请求体（仅所有者，docs/permission-design.md §6.2）：整体替换管理归属集合",
    "type": "object",
    "properties": {
      "managerIds": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "uniqueItems": true,
        "description": "新的管理归属集合，整体替换旧集合；空数组 = 未指派给任何用户管理员"
      }
    },
    "required": [
      "managerIds"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** ResetUserPasswordRequest — schemas/users/password.json */
export const usersPasswordSchema = {
    "$id": "users/password",
    "title": "ResetUserPasswordRequest",
    "description": "POST /api/users/:id/password 请求体（docs/permission-design.md §6.2）：所有者 / 用户管理员重置他人密码；本人改密走 /api/me/password",
    "type": "object",
    "properties": {
      "password": {
        "type": "string",
        "minLength": 8,
        "maxLength": 256,
        "description": "新的初始密码（至少 8 位）"
      },
      "mustChangePassword": {
        "type": "boolean",
        "default": true,
        "description": "是否要求该用户下次登录时修改密码，默认 true"
      }
    },
    "required": [
      "password"
    ],
    "additionalProperties": false
  } as const satisfies JsonSchema;

/** UpdateUserRequest — schemas/users/update.json */
export const usersUpdateSchema = {
    "$id": "users/update",
    "title": "UpdateUserRequest",
    "description": "PATCH /api/users/:id 请求体（docs/permission-design.md §6.2）：只改资料与状态；身份与权限字段被 additionalProperties:false 拒绝",
    "type": "object",
    "properties": {
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64,
        "description": "姓名"
      },
      "email": {
        "type": "string",
        "description": "邮箱，可留空字符串"
      },
      "phone": {
        "type": "string",
        "description": "手机号，可留空字符串"
      },
      "status": {
        "type": "string",
        "enum": [
          "active",
          "disabled"
        ],
        "description": "账号状态；停用会立即吊销该用户的会话与 MCP Token"
      }
    },
    "additionalProperties": false
  } as const satisfies JsonSchema;
