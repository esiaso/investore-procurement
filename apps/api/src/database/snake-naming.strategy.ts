import { DefaultNamingStrategy, NamingStrategyInterface, Table } from 'typeorm';

function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** snake_case tables and columns; deterministic constraint names. */
export class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
  override tableName(targetName: string, userSpecifiedName: string | undefined): string {
    return userSpecifiedName ?? snake(targetName);
  }

  override columnName(propertyName: string, customName: string | undefined, embeddedPrefixes: string[]): string {
    return snake(embeddedPrefixes.concat('').join('_')) + (customName ?? snake(propertyName));
  }

  override relationName(propertyName: string): string {
    return snake(propertyName);
  }

  override joinColumnName(relationName: string, referencedColumnName: string): string {
    return snake(`${relationName}_${referencedColumnName}`);
  }

  override joinTableName(firstTableName: string, secondTableName: string): string {
    return snake(`${firstTableName}_${secondTableName}`);
  }

  override joinTableColumnName(tableName: string, propertyName: string, columnName?: string): string {
    return snake(`${tableName}_${columnName ?? propertyName}`);
  }

  override primaryKeyName(tableOrName: Table | string): string {
    const table = typeof tableOrName === 'string' ? tableOrName : tableOrName.name;
    return `pk_${table}`.slice(0, 63);
  }
}
