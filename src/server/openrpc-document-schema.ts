/**
 * Minimal committed Zod schema for the OpenRPC document shape that Weft emits.
 *
 * @module server/openrpc-document-schema
 */
import { z } from 'zod';

import { MCP_DISCOVERY_PATH, MCP_TOOLS_LIST_METHOD } from './mcp-discovery.ts';

export const ContentDescriptorSchema = z.strictObject({
  name: z.string(),
  schema: z.record(z.string(), z.unknown()),
  required: z.boolean(),
});

const OpenRpcMcpMethodMetadataSchema = z.strictObject({
  workflowType: z.string(),
  toolName: z.string(),
  toolDiscovery: z.strictObject({
    method: z.literal(MCP_TOOLS_LIST_METHOD),
    source: z.literal('live'),
  }),
});

export const OpenRpcMethodSchema = z.strictObject({
  name: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.strictObject({ name: z.string() })).optional(),
  paramStructure: z.literal('by-name'),
  params: z.array(ContentDescriptorSchema),
  result: ContentDescriptorSchema,
  errors: z.array(z.strictObject({ $ref: z.string() })).optional(),
  'x-weft-paramsSchema': z.record(z.string(), z.unknown()),
  'x-weft-mcp': OpenRpcMcpMethodMetadataSchema.optional(),
});

const OpenRpcMcpMetadataSchema = z.strictObject({
  discoveryPath: z.literal(MCP_DISCOVERY_PATH),
  toolDiscoveryMethod: z.literal(MCP_TOOLS_LIST_METHOD),
  toolNames: z.array(z.string()),
});

export const OpenRpcDocumentSchema = z.strictObject({
  openrpc: z.literal('1.3.2'),
  info: z.strictObject({
    title: z.string(),
    version: z.string(),
    description: z.string().optional(),
    contact: z
      .strictObject({
        name: z.string().optional(),
        url: z.string().optional(),
        email: z.string().optional(),
      })
      .optional(),
    license: z
      .strictObject({
        name: z.string(),
        url: z.string().optional(),
      })
      .optional(),
    externalDocs: z
      .strictObject({
        description: z.string().optional(),
        url: z.string(),
      })
      .optional(),
  }),
  methods: z.array(OpenRpcMethodSchema),
  components: z
    .strictObject({
      errors: z
        .record(
          z.string(),
          z.strictObject({
            code: z.number(),
            message: z.string(),
            data: z.record(z.string(), z.unknown()).optional(),
            'x-http-status': z.number().optional(),
          }),
        )
        .optional(),
      schemas: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  servers: z.array(z.strictObject({ url: z.string() })).optional(),
  'x-weft-mcp': OpenRpcMcpMetadataSchema.optional(),
});

export type OpenRpcDocument = z.infer<typeof OpenRpcDocumentSchema>;
