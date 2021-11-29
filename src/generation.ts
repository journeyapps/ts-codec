import { AnyCodec, CodecType, IdentityCodec } from './definitions';
import * as defs from './definitions';

export enum TransformTarget {
  Encoded = 'encoded',
  Decoded = 'decoded'
}

export type CommonParams = {
  target: TransformTarget;
  parsers: Parser<string, AnyCodec>[];
  allowAdditional: boolean;
};

export type GenerationOptions = Partial<CommonParams>;

type RecursiveCodecCache = Map<string, any>;
type GenerationContext = CommonParams & {
  cache: RecursiveCodecCache;
};

export type ParserFunction<C extends AnyCodec> = (codec: C, options: GenerationContext) => any;
export type Parser<T extends string, C extends AnyCodec> = {
  tag: T;
  parse: ParserFunction<C>;
};

export const createParser = <C extends AnyCodec, T extends string = string>(
  tag: T,
  parser: ParserFunction<C>
): Parser<T, C> => {
  return {
    tag,
    parse: parser
  };
};

const createPrimitiveParser = <T extends CodecType>(type: T): Parser<T, IdentityCodec<T>> => {
  return {
    tag: type,
    parse: () => {
      return { type: type };
    }
  };
};

const StringParser = createPrimitiveParser(CodecType.String);
const NumberParser = createPrimitiveParser(CodecType.Number);
const BooleanParser = createPrimitiveParser(CodecType.Boolean);
const NullParser = createPrimitiveParser(CodecType.Null);

const AnyParser = createParser<defs.AnyCodec>(CodecType.Any, (codec) => {
  return {};
});

const EnumParser = createParser<defs.EnumCodec<any>>(CodecType.Enum, (codec) => {
  return {
    type: 'string',
    enum: Object.values(codec.props.enum)
  };
});

const LiteralParser = createParser<defs.LiteralCodec<any>>(CodecType.Literal, (codec) => {
  return {
    type: 'string',
    const: codec.props.value
  };
});

const ObjectParser = createParser<defs.ObjectCodec<defs.AnyObjectCodecShape>>(CodecType.Object, (codec, options) => {
  const entries = Object.entries(codec.props.shape);
  return {
    type: 'object',
    properties: entries.reduce((acc: Record<string, any>, [key, codec]) => {
      acc[key] = RootParser(codec, options);
      return acc;
    }, {}),
    additionalProperties: !!options?.allowAdditional,
    required: entries
      .filter(([, codec]) => {
        return codec.props.required;
      })
      .map(([key]) => key)
  };
});

const RecordParser = createParser<defs.RecordCodec<defs.AnyCodec>>(CodecType.Record, (codec, options) => {
  return {
    type: 'object',
    additionalProperties: RootParser(codec.props.type, options),
    properties: {},
    required: []
  };
});

const ArrayParser = createParser<defs.ArrayCodec<AnyCodec>>(CodecType.Array, (codec, options) => {
  return {
    type: 'array',
    items: RootParser(codec.props.type, options)
  };
});

const TupleParser = createParser<defs.TupleCodec<defs.AnyTuple>>(CodecType.Tuple, (codec, options) => {
  return {
    type: 'array',
    items: codec.props.codecs.map((codec) => RootParser(codec, options)),
    minItems: codec.props.codecs.length,
    maxItems: codec.props.codecs.length
  };
});

/**
 * Intersections are a bit complicated due to the way that additionalProperties works in JSON-Schema. To
 * support this we need to do different operations based on the type of codecs contained by the
 * intersection.
 *
 * If the intersection contains only object schemas then they are all merged under a single schema so
 * that `additionalProperties` applies against them simultaneously.
 *
 * If the intersection contains a mix of object schemas and unions then we need to construct the cartesian
 * product of all unions against all object schemas, combining them under a single `anyOf` definition. Each
 * product will be a merged schema with `additionalProperties` applying against all properties contained
 * within.
 *
 * Note: You can only really intersect object schemas and so we do not check for any other type of schema
 */
const IntersectionParser = createParser<defs.Intersection<AnyCodec, AnyCodec>>(
  CodecType.Intersection,
  (codec, options) => {
    const schemas = codec.props.codecs.map((codec) => RootParser(codec, options));

    const unions = schemas.filter((schema) => !!schema.anyOf);
    const object_schemas = schemas.filter((schema) => schema.type === 'object');

    const mergeObjectSchemas = (a: any, b: any) => {
      return {
        type: 'object',
        properties: {
          ...a.properties,
          ...b.properties
        },
        additionalProperties: !!options?.allowAdditional,
        required: [...a.required, ...b.required]
      };
    };

    if (unions.length > 0) {
      return {
        anyOf: unions.reduce((schemas: any[], union) => {
          return union.anyOf.reduce((schemas: any[], us: any) => {
            return object_schemas.reduce((schemas, os) => {
              return schemas.concat(mergeObjectSchemas(os, us));
            }, schemas);
          }, schemas);
        }, [])
      };
    }

    return {
      type: 'object',
      properties: schemas.reduce((properties, schema: any) => {
        return {
          ...properties,
          ...(schema.properties || {})
        };
      }, {}),
      additionalProperties: !!options?.allowAdditional,
      required: schemas.reduce((required: string[], schema: any) => {
        return required.concat(schema.required || []);
      }, [])
    };
  }
);

const UnionParser = createParser<defs.Union<AnyCodec, AnyCodec>>(CodecType.Union, (codec, options) => {
  return {
    anyOf: codec.props.codecs.map((codec) => RootParser(codec, options))
  };
});

const RecursiveParser = createParser<defs.RecursiveCodec<AnyCodec>>(CodecType.Recursive, (codec, options) => {
  const ref = {
    $ref: `#/definitions/${codec.props.id}`
  };

  const cached = options.cache.get(codec.props.id);
  if (cached) {
    return ref;
  }

  options.cache.set(codec.props.id, {});
  /**
   * The schema is applied to the definition _after_ pushing the definition to the cache
   * to ensure that there are no cache misses from calling RootParser
   */
  options.cache.set(codec.props.id, RootParser(codec.props.resolver(), options));

  return ref;
});

const RootParser = (codec: AnyCodec, options: GenerationContext) => {
  const parser = options.parsers.find((parser) => parser.tag === codec._tag);
  if (!parser) {
    throw new Error(`No parser configured for codec ${codec._tag}`);
  }
  const schema = parser.parse(codec, options);

  if (codec.props.metadata?.description) {
    return {
      description: codec.props.metadata.description,
      ...schema
    };
  }

  return schema;
};

export const generateJSONSchema = (codec: AnyCodec, options?: GenerationOptions): Record<string, any> => {
  const parsers: Parser<any, any>[] = [
    ...(options?.parsers || []),
    AnyParser,
    StringParser,
    NumberParser,
    BooleanParser,
    NullParser,
    LiteralParser,
    EnumParser,
    ObjectParser,
    RecordParser,
    ArrayParser,
    TupleParser,
    IntersectionParser,
    UnionParser,
    RecursiveParser
  ];

  const recursion_cache: RecursiveCodecCache = new Map();
  const schema = RootParser(codec, {
    parsers,
    target: options?.target ?? TransformTarget.Encoded,
    allowAdditional: options?.allowAdditional ?? false,
    cache: recursion_cache
  });

  return {
    definitions: Object.fromEntries(recursion_cache.entries()),
    ...schema
  };
};
