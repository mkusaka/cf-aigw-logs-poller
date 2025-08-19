import { describe, it, expect, beforeAll } from 'vitest';

// Mock environment for integration tests
const FAKE_GCS_BASE_URL = "http://localhost:4443";
const TEST_BUCKET = "test-bucket";

/**
 * Utility function to upload JSONL to fake GCS server
 * This mimics the uploadJsonlCreateOnly function from the main code
 */
async function uploadJsonlToFakeGcs(
  objectName: string, 
  jsonLine: string,
  options: { ifGenerationMatch?: string } = {}
): Promise<Response> {
  const url = new URL(`${FAKE_GCS_BASE_URL}/storage/v1/b/${encodeURIComponent(TEST_BUCKET)}/o`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", objectName);
  
  if (options.ifGenerationMatch) {
    url.searchParams.set("ifGenerationMatch", options.ifGenerationMatch);
  }

  return fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-ndjson",
    },
    body: jsonLine,
  });
}

/**
 * Utility function to list objects in fake GCS bucket
 */
async function listObjectsInFakeGcs(): Promise<any> {
  const url = `${FAKE_GCS_BASE_URL}/storage/v1/b/${TEST_BUCKET}/o`;
  const response = await fetch(url);
  return response.json();
}

/**
 * Utility function to get object from fake GCS bucket
 */
async function getObjectFromFakeGcs(objectName: string): Promise<string> {
  const url = `${FAKE_GCS_BASE_URL}/storage/v1/b/${TEST_BUCKET}/o/${encodeURIComponent(objectName)}?alt=media`;
  const response = await fetch(url);
  return response.text();
}

/**
 * Utility function to delete object from fake GCS bucket
 */
async function deleteObjectFromFakeGcs(objectName: string): Promise<Response> {
  const url = `${FAKE_GCS_BASE_URL}/storage/v1/b/${TEST_BUCKET}/o/${encodeURIComponent(objectName)}`;
  return fetch(url, { method: "DELETE" });
}

/**
 * Test path generation utility (same as in main code)
 */
function pathForRow(prefix: string, createdAtISO: string, id: string): string {
  const d = new Date(createdAtISO);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${prefix}/dt=${yyyy}-${mm}-${dd}/hour=${hh}/${id}.jsonl`;
}

// Skip integration tests if fake GCS is not available
const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === 'true';

describe('GCS Integration Tests', () => {
  beforeAll(async () => {
    if (!runIntegrationTests) {
      console.log('Skipping integration tests. Set RUN_INTEGRATION_TESTS=true to run.');
      return;
    }

    // Check if fake GCS server is available
    try {
      const healthCheck = await fetch(`${FAKE_GCS_BASE_URL}/storage/v1/b`, { 
        signal: AbortSignal.timeout(5000) 
      });
      if (!healthCheck.ok) {
        throw new Error(`Health check failed: ${healthCheck.status}`);
      }
    } catch (error) {
      throw new Error(
        `Fake GCS server is not available at ${FAKE_GCS_BASE_URL}. ` +
        'Please run "docker compose up -d" first.'
      );
    }
  });

  it.skipIf(!runIntegrationTests)('should upload JSONL file to fake GCS', async () => {
    const testRow = {
      id: "01HKJ8XXXXXXXXXXXXXXXXXXX",
      created_at: "2023-12-25T14:30:45.123Z",
      provider: "openai",
      model: "gpt-4",
      tokens_in: 100,
      tokens_out: 200,
      duration: 1500,
      success: true,
      cost: 0.001
    };

    const path = pathForRow("rows", testRow.created_at, testRow.id);
    const jsonLine = JSON.stringify(testRow) + "\n";

    const response = await uploadJsonlToFakeGcs(path, jsonLine);
    expect(response.ok).toBe(true);

    // Verify the file was uploaded
    const objects = await listObjectsInFakeGcs();
    expect(objects.items).toBeDefined();
    
    const uploadedFile = objects.items?.find((item: any) => item.name === path);
    expect(uploadedFile).toBeDefined();
    expect(uploadedFile.name).toBe("rows/dt=2023-12-25/hour=14/01HKJ8XXXXXXXXXXXXXXXXXXX.jsonl");

    // Verify the content
    const content = await getObjectFromFakeGcs(path);
    expect(content).toBe(jsonLine);

    // Cleanup
    await deleteObjectFromFakeGcs(path);
  });

  it.skipIf(!runIntegrationTests)('should prevent duplicate uploads with ifGenerationMatch=0', async () => {
    const testRow = {
      id: "01ABC123DUPLICATE456789XYZ",
      created_at: "2023-12-25T15:00:00.000Z",
      provider: "anthropic",
      model: "claude-3",
      tokens_in: 150,
      tokens_out: 300,
      duration: 2000,
      success: true,
      cost: 0.002
    };

    const path = pathForRow("rows", testRow.created_at, testRow.id);
    const jsonLine = JSON.stringify(testRow) + "\n";

    // First upload should succeed
    const firstUpload = await uploadJsonlToFakeGcs(path, jsonLine, { ifGenerationMatch: "0" });
    expect(firstUpload.ok).toBe(true);

    // Second upload with ifGenerationMatch=0 should fail (file already exists)
    const secondUpload = await uploadJsonlToFakeGcs(path, jsonLine, { ifGenerationMatch: "0" });
    expect(secondUpload.ok).toBe(false);
    expect(secondUpload.status).toBe(412); // Precondition Failed

    // Cleanup
    await deleteObjectFromFakeGcs(path);
  });

  it.skipIf(!runIntegrationTests)('should handle multiple files with different timestamps', async () => {
    const testRows = [
      {
        id: "01TEST1MULTIFILE1234567",
        created_at: "2023-12-25T10:30:00.000Z",
        provider: "openai",
      },
      {
        id: "01TEST2MULTIFILE7654321", 
        created_at: "2023-12-25T11:45:00.000Z",
        provider: "anthropic",
      },
      {
        id: "01TEST3MULTIFILE9876543",
        created_at: "2023-12-25T12:15:00.000Z", 
        provider: "cohere",
      }
    ];

    const uploadPromises = testRows.map(async (row) => {
      const path = pathForRow("rows", row.created_at, row.id);
      const jsonLine = JSON.stringify(row) + "\n";
      return uploadJsonlToFakeGcs(path, jsonLine);
    });

    const responses = await Promise.all(uploadPromises);
    responses.forEach(response => {
      expect(response.ok).toBe(true);
    });

    // Verify all files were uploaded  
    const objects = await listObjectsInFakeGcs();
    expect(objects.items?.length).toBeGreaterThanOrEqual(3);

    const expectedPaths = [
      "rows/dt=2023-12-25/hour=10/01TEST1MULTIFILE1234567.jsonl",
      "rows/dt=2023-12-25/hour=11/01TEST2MULTIFILE7654321.jsonl", 
      "rows/dt=2023-12-25/hour=12/01TEST3MULTIFILE9876543.jsonl"
    ];

    for (const expectedPath of expectedPaths) {
      const file = objects.items?.find((item: any) => item.name === expectedPath);
      expect(file).toBeDefined();
    }

    // Cleanup
    for (const row of testRows) {
      const path = pathForRow("rows", row.created_at, row.id);
      await deleteObjectFromFakeGcs(path);
    }
  });

  it.skipIf(!runIntegrationTests)('should create correct Hive partition structure', async () => {
    const testRow = {
      id: "01HIVE123PARTITION456789",
      created_at: "2023-06-15T23:59:59.999Z",
      provider: "openai"
    };

    const path = pathForRow("test-prefix", testRow.created_at, testRow.id);
    const jsonLine = JSON.stringify(testRow) + "\n";

    const response = await uploadJsonlToFakeGcs(path, jsonLine);
    expect(response.ok).toBe(true);

    // Verify the Hive partition path structure
    expect(path).toBe("test-prefix/dt=2023-06-15/hour=23/01HIVE123PARTITION456789.jsonl");
    
    const objects = await listObjectsInFakeGcs();
    const uploadedFile = objects.items?.find((item: any) => item.name === path);
    expect(uploadedFile).toBeDefined();

    // Cleanup
    await deleteObjectFromFakeGcs(path);
  });
});