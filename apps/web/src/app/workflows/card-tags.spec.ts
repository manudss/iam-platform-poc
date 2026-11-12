import {fittingTags} from './card-tags';
describe('single-line workflow tags',()=>{
 it('shows all tags when they fit with gaps',()=>{expect(fittingTags([30,40,50],132,()=>32)).toBe(3);});
 it('reserves the overflow chip and hides whole tags',()=>{expect(fittingTags([30,40,50],100,()=>32)).toBe(1);expect(fittingTags([30,40,50],114,()=>32)).toBe(2);});
 it('handles long tags, zero width and empty lists',()=>{expect(fittingTags([400,30],100,()=>32)).toBe(0);expect(fittingTags([30],0,()=>32)).toBe(0);expect(fittingTags([],100,()=>32)).toBe(0);});
});
