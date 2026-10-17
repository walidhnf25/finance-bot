import { splitSegments } from './segments';

describe('splitSegments', () => {
  it('splits on commas', () => {
    expect(splitSegments('beli ayam 8 ribu, beli es teh manis 5 ribu')).toEqual([
      'beli ayam 8 ribu',
      'beli es teh manis 5 ribu',
    ]);
  });

  it('splits on semicolons and line breaks', () => {
    expect(splitSegments('beli ayam 8rb; beli es teh 5rb')).toEqual([
      'beli ayam 8rb',
      'beli es teh 5rb',
    ]);
    expect(splitSegments('beli ayam 8rb\nbeli es teh 5rb\r\nbeli roti 3rb')).toEqual([
      'beli ayam 8rb',
      'beli es teh 5rb',
      'beli roti 3rb',
    ]);
  });

  it('splits when there is no space after the comma', () => {
    expect(splitSegments('ayam 8rb,teh 5rb')).toEqual(['ayam 8rb', 'teh 5rb']);
    expect(splitSegments('ayam 8000,teh 5000')).toEqual(['ayam 8000', 'teh 5000']);
  });

  it('keeps a decimal comma inside an amount', () => {
    expect(splitSegments('beli laptop 1,5jt, beli mouse 200rb')).toEqual([
      'beli laptop 1,5jt',
      'beli mouse 200rb',
    ]);
    expect(splitSegments('gaji 2,5 juta')).toEqual(['gaji 2,5 juta']);
  });

  it('drops empty parts and trims whitespace', () => {
    expect(splitSegments('  beli ayam 8rb ,, ; beli teh 5rb ,  ')).toEqual([
      'beli ayam 8rb',
      'beli teh 5rb',
    ]);
    expect(splitSegments('')).toEqual([]);
  });

  it('returns a single part when there is nothing to split', () => {
    expect(splitSegments('beli kopi 25rb')).toEqual(['beli kopi 25rb']);
  });
});
