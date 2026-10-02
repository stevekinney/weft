import type { WeftClient as WeftClientFromCliBarrel } from '../cli/index.ts';
import type {
  CatalogOperationTypes,
  CatalogOperations,
  CatalogWeftClient,
  ClientOperations,
  WeftClient as WeftClientFromRoot,
} from '../index.ts';
import { createWeftClient } from '../index.ts';
import type { WeftClient as WeftClientFromInterface } from './interface.ts';

type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

const rootKeepsInterface: Equals<WeftClientFromRoot, WeftClientFromInterface> = true;
void rootKeepsInterface;

const cliKeepsInterface: Equals<WeftClientFromCliBarrel, WeftClientFromInterface> = true;
void cliKeepsInterface;

const namesFactoryReturn: Equals<CatalogOperations, ReturnType<typeof createWeftClient>> = true;
void namesFactoryReturn;

const namesCatalogClient: Equals<
  CatalogOperations,
  CatalogWeftClient<CatalogOperationTypes>
> = true;
void namesCatalogClient;

const distinctFromInterface: Equals<CatalogOperations, WeftClientFromInterface> = false;
void distinctFromInterface;

const distinctFromRestClient: Equals<CatalogOperations, ClientOperations> = false;
void distinctFromRestClient;

const client: CatalogOperations = createWeftClient();
void client;
