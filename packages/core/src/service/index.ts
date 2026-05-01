import { formatLocateCandidatesForPrompt } from '@/agent/recovery';
import { isAutoGLM, isUITars } from '@/ai-model/auto-glm/util';
import {
  AIResponseParseError,
  AiExtractElementInfo,
  AiLocateElement,
  callAIWithObjectResponse,
} from '@/ai-model/index';
import { AiLocateSection, buildSearchAreaConfig } from '@/ai-model/inspect';
import { elementDescriberInstruction } from '@/ai-model/prompt/describe';
import { type AIArgs, expandSearchArea } from '@/common';
import type {
  AIDescribeElementResponse,
  AIUsageInfo,
  DetailedLocateParam,
  LocateCandidate,
  LocateResultElement,
  LocateResultWithDump,
  PartialServiceDumpFromSDK,
  PlanningLocateParam,
  Rect,
  ServiceDump,
  ServiceExtractOption,
  ServiceExtractParam,
  ServiceExtractResult,
  ServiceTaskInfo,
  UIContext,
} from '@/types';
import { ServiceError } from '@/types';
import type { IModelConfig } from '@midscene/shared/env';
import { compositeElementInfoImg, cropByRect } from '@midscene/shared/img';
import { getDebug } from '@midscene/shared/logger';
import { assert } from '@midscene/shared/utils';
import type { TMultimodalPrompt } from '../common';
import { createServiceDump } from './utils';

export interface LocateOpts {
  context?: UIContext;
  planLocatedElement?: LocateResultElement;
}

export type AnyValue<T> = {
  [K in keyof T]: unknown extends T[K] ? any : T[K];
};

interface ServiceOptions {
  taskInfo?: Omit<ServiceTaskInfo, 'durationMs'>;
}

const debug = getDebug('ai:service');
export default class Service {
  contextRetrieverFn: () => Promise<UIContext> | UIContext;

  taskInfo?: Omit<ServiceTaskInfo, 'durationMs'>;

  constructor(
    context: UIContext | (() => Promise<UIContext> | UIContext),
    opt?: ServiceOptions,
  ) {
    assert(context, 'context is required for Service');
    if (typeof context === 'function') {
      this.contextRetrieverFn = context;
    } else {
      this.contextRetrieverFn = () => Promise.resolve(context);
    }

    if (typeof opt?.taskInfo !== 'undefined') {
      this.taskInfo = opt.taskInfo;
    }
  }

  async locate(
    query: PlanningLocateParam,
    opt: LocateOpts,
    modelConfig: IModelConfig,
    abortSignal?: AbortSignal,
  ): Promise<LocateResultWithDump> {
    const queryPrompt = typeof query === 'string' ? query : query.prompt;
    assert(queryPrompt, 'query is required for locate');

    assert(typeof query === 'object', 'query should be an object for locate');

    const hasPlanLocatedElement = !!opt?.planLocatedElement?.rect;

    let searchAreaPrompt;
    if (query.deepLocate && !hasPlanLocatedElement) {
      searchAreaPrompt = query.prompt;
    }

    const { modelFamily } = modelConfig;

    if (searchAreaPrompt && !modelFamily) {
      console.warn(
        'The "deepLocate" feature is not supported with multimodal LLM. Please config VL model for Midscene. https://midscenejs.com/model-config',
      );
      searchAreaPrompt = undefined;
    }

    if (searchAreaPrompt && isAutoGLM(modelFamily)) {
      console.warn('The "deepLocate" feature is not supported with AutoGLM.');
      searchAreaPrompt = undefined;
    }

    const context = opt?.context || (await this.contextRetrieverFn());

    let searchArea: Rect | undefined = undefined;
    let searchAreaRawResponse: string | undefined = undefined;
    let searchAreaUsage: AIUsageInfo | undefined = undefined;
    let searchAreaResponse:
      | Awaited<ReturnType<typeof AiLocateSection>>
      | undefined = undefined;
    if (query.deepLocate && hasPlanLocatedElement) {
      const searchAreaConfig = await buildSearchAreaConfig({
        context,
        baseRect: opt.planLocatedElement!.rect,
        modelFamily,
      });
      searchArea = searchAreaConfig.rect;

      searchAreaRawResponse = JSON.stringify({
        source: 'plan-located-element',
        rect: opt.planLocatedElement!.rect,
      });
      searchAreaResponse = {
        rect: searchArea,
        imageBase64: searchAreaConfig.imageBase64,
        scale: searchAreaConfig.scale,
        rawResponse: searchAreaRawResponse,
      };
    } else if (searchAreaPrompt) {
      searchAreaResponse = await AiLocateSection({
        context,
        sectionDescription: searchAreaPrompt,
        modelConfig,
        abortSignal,
      });
      assert(
        searchAreaResponse.rect,
        `cannot find search area for "${searchAreaPrompt}"${
          searchAreaResponse.error ? `: ${searchAreaResponse.error}` : ''
        }`,
      );
      searchAreaRawResponse = searchAreaResponse.rawResponse;
      searchAreaUsage = searchAreaResponse.usage;
      searchArea = searchAreaResponse.rect;
    }

    const startTime = Date.now();
    const { parseResult, rect, rawResponse, usage, reasoning_content } =
      await AiLocateElement({
        context,
        targetElementDescription: queryPrompt,
        searchConfig: searchAreaResponse,
        modelConfig,
        abortSignal,
      });

    const timeCost = Date.now() - startTime;
    const taskInfo: ServiceTaskInfo = {
      ...(this.taskInfo ? this.taskInfo : {}),
      durationMs: timeCost,
      rawResponse: JSON.stringify(rawResponse),
      formatResponse: JSON.stringify(parseResult),
      usage,
      searchArea,
      searchAreaRawResponse,
      searchAreaUsage,
      reasoning_content,
    };

    let errorLog: string | undefined;
    if (parseResult.errors?.length) {
      errorLog = `failed to locate element: \n${parseResult.errors.join('\n')}`;
    }

    const dumpData: PartialServiceDumpFromSDK = {
      type: 'locate',
      userQuery: {
        element: queryPrompt,
      },
      matchedElement: [],
      matchedRect: rect,
      data: null,
      taskInfo,
      deepLocate: !!searchArea,
      error: errorLog,
    };

    const elements = parseResult.elements || [];

    const dump = createServiceDump({
      ...dumpData,
      matchedElement: elements,
    });

    if (errorLog) {
      throw new ServiceError(errorLog, dump);
    }

    if (elements.length > 1) {
      throw new ServiceError(
        `locate: multiple elements found, length = ${elements.length}`,
        dump,
      );
    }

    if (elements.length === 1) {
      return {
        element: {
          center: elements[0]!.center,
          rect: elements[0]!.rect,
          description: elements[0]!.description,
        },
        rect,
        dump,
      };
    }

    return {
      element: null,
      rect,
      dump,
    };
  }

  async adjudicateLocateCandidate(
    query: PlanningLocateParam,
    candidates: LocateCandidate[],
    modelConfig: IModelConfig,
    options?: {
      context?: UIContext;
      abortSignal?: AbortSignal;
      maxCandidates?: number;
    },
  ): Promise<{
    candidate: LocateCandidate | null;
    index?: number;
    thought?: string;
    dump?: ServiceDump;
  }> {
    if (!candidates.length) {
      return { candidate: null };
    }

    const target =
      typeof query.prompt === 'string' ? query.prompt : query.prompt?.prompt;
    assert(target, 'query.prompt is required for candidate adjudication');

    const candidateText = formatLocateCandidatesForPrompt(
      candidates,
      options?.maxCandidates,
    );
    const demand = {
      candidateIndex: [
        `Choose the single best candidate for the target: "${target}".`,
        'Return only a 1-based candidate index from the list, or 0 if none of them match.',
        'Do not choose a candidate outside the list.',
        `Candidates:\n${candidateText}`,
      ].join('\n'),
      reason: 'Brief reason for the chosen candidate.',
    };

    const result = await this.extract<{
      candidateIndex?: number | string;
      index?: number | string;
      result?: number | string;
      reason?: string;
    }>(
      demand,
      modelConfig,
      {
        domIncluded: false,
        screenshotIncluded: false,
      },
      undefined,
      undefined,
      options?.context ?? (await this.contextRetrieverFn()),
    );

    const index = parseCandidateIndex(result.data, candidates.length);
    if (index === undefined) {
      return {
        candidate: null,
        thought: result.thought ?? result.data?.reason,
        dump: result.dump,
      };
    }

    return {
      candidate: candidates[index],
      index,
      thought: result.thought ?? result.data?.reason,
      dump: result.dump,
    };
  }

  async extract<T>(
    dataDemand: ServiceExtractParam,
    modelConfig: IModelConfig,
    opt?: ServiceExtractOption,
    pageDescription?: string,
    multimodalPrompt?: TMultimodalPrompt,
    context?: UIContext,
  ): Promise<ServiceExtractResult<T>> {
    assert(context, 'context is required for extract');
    assert(
      typeof dataDemand === 'object' || typeof dataDemand === 'string',
      `dataDemand should be object or string, but get ${typeof dataDemand}`,
    );

    const startTime = Date.now();

    let parseResult: Awaited<
      ReturnType<typeof AiExtractElementInfo<T>>
    >['parseResult'];
    let rawResponse: string;
    let usage: Awaited<ReturnType<typeof AiExtractElementInfo<T>>>['usage'];
    let reasoning_content: string | undefined;

    try {
      const result = await AiExtractElementInfo<T>({
        context,
        dataQuery: dataDemand,
        multimodalPrompt,
        extractOption: opt,
        modelConfig,
        pageDescription,
      });
      parseResult = result.parseResult;
      rawResponse = result.rawResponse;
      usage = result.usage;
      reasoning_content = result.reasoning_content;
    } catch (error) {
      if (error instanceof AIResponseParseError) {
        // Create dump with usage and rawResponse from the error
        const timeCost = Date.now() - startTime;
        const taskInfo: ServiceTaskInfo = {
          ...(this.taskInfo ? this.taskInfo : {}),
          durationMs: timeCost,
          rawResponse: error.rawResponse,
          usage: error.usage,
        };
        const dump = createServiceDump({
          type: 'extract',
          userQuery: { dataDemand },
          matchedElement: [],
          data: null,
          taskInfo,
          error: error.message,
        });
        throw new ServiceError(error.message, dump);
      }
      throw error;
    }

    const timeCost = Date.now() - startTime;
    const taskInfo: ServiceTaskInfo = {
      ...(this.taskInfo ? this.taskInfo : {}),
      durationMs: timeCost,
      rawResponse,
      formatResponse: JSON.stringify(parseResult),
      usage,
      reasoning_content,
    };

    let errorLog: string | undefined;
    if (parseResult.errors?.length) {
      errorLog = `AI response error: \n${parseResult.errors.join('\n')}`;
    }

    const dumpData: PartialServiceDumpFromSDK = {
      type: 'extract',
      userQuery: {
        dataDemand,
      },
      matchedElement: [],
      data: null,
      taskInfo,
      error: errorLog,
    };

    const { data, thought } = parseResult || {};

    const dump = createServiceDump({
      ...dumpData,
      data,
    });

    if (errorLog && !data) {
      throw new ServiceError(errorLog, dump);
    }

    return {
      data,
      thought,
      usage,
      reasoning_content,
      dump,
    };
  }

  async describe(
    target: Rect | [number, number],
    modelConfig: IModelConfig,
    opt?: {
      deepLocate?: boolean;
    },
  ): Promise<Pick<AIDescribeElementResponse, 'description'>> {
    assert(target, 'target is required for service.describe');
    const context = await this.contextRetrieverFn();
    const { shotSize } = context;
    const screenshotBase64 = context.screenshot.base64;
    assert(screenshotBase64, 'screenshot is required for service.describe');
    // The result of the "describe" function will be used for positioning, so essentially it is a form of grounding.
    const { modelFamily } = modelConfig;
    const systemPrompt = elementDescriberInstruction();

    // Convert [x,y] center point to Rect if needed
    const defaultRectSize = 30;
    const targetRect: Rect = Array.isArray(target)
      ? {
          left: Math.floor(target[0] - defaultRectSize / 2),
          top: Math.floor(target[1] - defaultRectSize / 2),
          width: defaultRectSize,
          height: defaultRectSize,
        }
      : target;

    let imagePayload = await compositeElementInfoImg({
      inputImgBase64: screenshotBase64,
      size: shotSize,
      elementsPositionInfo: [
        {
          rect: targetRect,
        },
      ],
      borderThickness: 3,
    });

    if (opt?.deepLocate) {
      const searchArea = expandSearchArea(targetRect, shotSize);
      // Always crop in describe mode. Unlike locate's deepLocate (where
      // cropping too small loses context for finding elements), describe's
      // deepLocate intentionally zooms in so the model produces a more
      // precise description from a focused view. expandSearchArea already
      // guarantees a minimum 400x400 area with surrounding context.
      debug('describe: cropping to searchArea', searchArea);
      const croppedResult = await cropByRect(
        imagePayload,
        searchArea,
        modelFamily === 'qwen2.5-vl',
      );
      imagePayload = croppedResult.imageBase64;
    }

    const msgs: AIArgs = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: imagePayload,
              detail: 'high',
            },
          },
        ],
      },
    ];

    const res = await callAIWithObjectResponse<AIDescribeElementResponse>(
      msgs,
      modelConfig,
    );

    const { content } = res;
    assert(!content.error, `describe failed: ${content.error}`);
    assert(content.description, 'failed to describe the element');
    return content;
  }
}

function parseCandidateIndex(
  data: unknown,
  candidateCount: number,
): number | undefined {
  const value =
    data && typeof data === 'object'
      ? ((data as Record<string, unknown>).candidateIndex ??
        (data as Record<string, unknown>).index ??
        (data as Record<string, unknown>).result)
      : data;
  const numberValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return undefined;
  }

  const zeroBasedIndex = numberValue - 1;
  if (zeroBasedIndex < 0 || zeroBasedIndex >= candidateCount) {
    return undefined;
  }
  return zeroBasedIndex;
}
