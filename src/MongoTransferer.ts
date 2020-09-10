import { omit } from "lodash";
import { Observable, defer, EMPTY, merge, of } from "rxjs";
import { filter, scan, catchError, switchMapTo, mergeAll, finalize } from 'rxjs/operators';
import { eachValueFrom } from "rxjs-for-await";

import { SourceConnector, TargetConnector } from "./connectors/Connector";
import { Progress } from "./contracts";

interface MongoTransfererOptions {
  source: SourceConnector;
  targets: TargetConnector[];
}

/**
 * Transfers a snapshot of a database and stream it׳s content.
 * During the process the module emit events regarding the transfer process that you can subscribe to.
 */
export class MongoTransferer implements AsyncIterable<Progress> {
  private source: SourceConnector;
  private targets: TargetConnector[];

  constructor({ source, targets = [] }: MongoTransfererOptions) {
    this.source = source;
    this.targets = [...targets];
  }

  [Symbol.asyncIterator]() {
    return this.iterator();
  }

  /**
   * Allows an easier iteration across the transferer events.
   * Lazingly start the transfer operation.
   * As long as there was no execution of "for await ..." expression the transfer process wont start.
   *
   * @example
   * ```js
   * const source = new LocalFileSystemDuplexConnector(...);
   * const target = new MongoDBDuplexConnector(...);
   * 
   * const transferer = new MongoTransferer({ source, targets: [target] });
   *
   * for await (const progress of transferer.iterator()) {
   *    console.log(progress);
   * }
   * ```
   */
  iterator() {
    return eachValueFrom(this.transfer$());
  }

  /**
   * Returns a promise that allows you to await until the transfer operation is done.
   * The promise might be rejected if there was a critical error.
   * If the promise was fullfilled it will provide a summary details of the transfer operation.
   */
  async promise() {
    return this.transfer$().toPromise();
  }

  /**
   * Returns a stream transferer progression events to listen to during the transfer process.
   */
  transfer$(): Observable<Progress> {
    return defer(async () => {
      const connectors = [this.source, ...this.targets];

      if (this.targets.length === 0) {
        return of({
          total: 0,
          write: 0
        });
      }

      // validate and connect to all connectors
      await Promise.all(connectors.map(connector => connector.validate()));
      await Promise.all(connectors.map(connector => connector.connect()));

      const metadatas = (await this.source.transferable()).filter((metadata) => {
        const filter_collections = this.source.assource.collections || [];

        return (filter_collections.length > 0 && filter_collections.includes(metadata.name)) || (filter_collections.length === 0);
      }).map(metadata => ({
        ...metadata,
        indexes: (metadata.indexes || []).map(index => omit(index, ['ns']))
      }));

      const datas =
        metadatas.map(metadata => ({
          data$: this.source.data$(metadata.name),
          metadata
        }));

      // cleanup all the targets before creating and writing data into them
      await Promise.all(
        this.targets.filter(target => target.astarget.remove_on_startup).map(
          async target => {
            if (await target.exists()) {
              await target.remove();
            }
          }
        )
      );

      const writes = this.targets.map(target => {
        const collections = datas.filter(({ metadata: { name } }) => {
          const filter_collections = target.astarget.collections || [];

          return (filter_collections.length > 0 && filter_collections.includes(name)) || (filter_collections.length === 0);
        });

        return {
          size: collections.reduce((total, { metadata: { size } }) => total + size, 0),
          write$: collections.length === 0 ? EMPTY : target.write(collections).pipe(
            catchError((error) => {
              return defer(async () => {
                console.error(`could not write collection data into: ${await target.fullname()} due to error:`);
                console.error(error);

                if (
                  target.astarget.remove_on_failure &&
                  await target.exists()
                ) {
                  console.warn(`removing: "${await target.fullname()}" because an error was thrown during the transfer`);

                  await target.remove();
                }
              }).pipe(switchMapTo(EMPTY));
            }),
            finalize(async () => {
              await target.close();
            })
          )
        }
      });

      return merge(...writes.map(write => write.write$))
        .pipe(
          filter((write_size) => write_size > 0),
          scan((acc: Progress, write_size: number) => ({
            ...acc,
            write: acc.write + write_size
          }),
            {
              total: writes.reduce((total, { size }) => total + size, 0),
              write: 0,
            }
          )
        );
    }).pipe(
      mergeAll(),
      finalize(async () => {
        await this.source.close();
      })
    );
  }
}
