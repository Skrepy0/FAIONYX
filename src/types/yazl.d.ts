declare module 'yazl' {
  import type { Readable } from 'node:stream';
  export interface AddOptions {
    mtime?: Date;
    mode?: number;
    compress?: boolean;
    forceZip64Format?: boolean;
  }
  export class ZipFile {
    outputStream: Readable;
    addFile(realPath: string, metadataPath: string, options?: AddOptions): void;
    addBuffer(buffer: Buffer, metadataPath: string, options?: AddOptions): void;
    addReadStream(input: Readable, metadataPath: string, options?: AddOptions): void;
    addEmptyDirectory(metadataPath: string, options?: AddOptions): void;
    end(): void;
  }
}
