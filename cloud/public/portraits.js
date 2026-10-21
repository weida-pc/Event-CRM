// Memory-only DOM reuse: polling and filter changes must not re-download portraits.
// No persistent browser storage; discard records when identity, scope or access changes.
export class Portraits {
  constructor(){this.records=new Map();}
  get(person,create){
    const version=JSON.stringify([person.name,person.company,person.title,person.research?.updatedAt]);
    let record=this.records.get(person.id);
    if(!record||record.version!==version){record={version,state:'pending'};record.node=create(record);this.records.set(person.id,record);}
    return record.node;
  }
  retain(people){
    const ids=new Set(people.filter(p=>p.research?.photoState==='stored').map(p=>p.id));
    for(const id of this.records.keys())if(!ids.has(id))this.records.delete(id);
  }
  counts(){
    const visible=[...this.records.values()].filter(r=>r.node.isConnected);
    return {loaded:visible.filter(r=>r.state==='loaded').length,failed:visible.filter(r=>r.state==='failed').length};
  }
  clear(){this.records.clear();}
}
