import { flow, mapValues, range, sortBy, sum } from "lodash-es";
import assert from "node:assert";
import fsp from "node:fs/promises";
import pathUtils from "node:path";
import { HashMap } from "@thi.ng/associative";

const cwd = pathUtils.dirname(new URL(import.meta.url).pathname);

type PositionString = string;
// type PositionString = `${string},${number},${number}`;
type Position = [x: number, y: number, mapId: string];
interface MStatus {
    hp: number;
    at: number;
    df: number;
    mf: number;
    yk: number;
    bk: number;
    rk: number;
    gk: number;
    ik: number;
    equip_level: number;
    total_dam: number;
    curse: number;
}
type MStatusDelta = Partial<MStatus>;
type MEvent = ["door", "yk" | "bk" | "rk" | "gk" | "ik"] | ["enemy", number] | ["delta", MStatusDelta];

interface Enemy {
    hp: number;
    at: number;
    df: number;
    spec: number | number[];
    point: number;
    n: number;
}

interface AIInfo {
    main_point_adj_d: Record<PositionString, PositionString[]>;
    conn_comp: [PositionString[], MStatusDelta][];
    main_point_desc: Record<PositionString, MEvent>;
    enemy_list: Record<number, Enemy>;
    std_form: PositionString[][];
    init_state: MStatus;
    init_avail_set: PositionString[];
}

const encodePos = ([x, y, mapId]: Position): PositionString => `${mapId},${x},${y}`;
const decodePos = (str: PositionString) => {
    const [mapId, x, y] = str.split(",");
    return [Number(x), Number(y), mapId];
};

type SearchStateKey = Set<number>;
type SearchStateItem = [MStatus, Set<string>, Set<number>, number[]];
type SearchStateEntry = [SearchStateKey, SearchStateItem];
type SearchStateMap = HashMap<SearchStateKey, SearchStateItem>;

const createSearchState = (items: SearchStateEntry[] = []) => {
    return new HashMap<SearchStateKey, SearchStateItem>(items, {
        equiv: (a, b) => a.isSubsetOf(b) && a.isSupersetOf(b),
        hash: (e) => [...e.values()].sort().reduce((prev, e, i) => (prev * 29 + e) % 19260817, 0),
    });
}

(async () => {
    const aiInfo = await fsp
        .readFile(pathUtils.join(cwd, "ai_info.json"), "utf-8")
        .then((e) => JSON.parse(e) as AIInfo);

    // console.log(aiInfo);

    const {
        main_point_adj_d,
        conn_comp: raw_conn_comp,
        main_point_desc,
        enemy_list,
        std_form,
        init_state,
        init_avail_set: raw_init_avail_set,
    } = aiInfo;

    const conn_comp = raw_conn_comp.map(([k, v]) => [new Set(k), v] as const);
    const init_avail_set = new Set(raw_init_avail_set);

    const m2cc = mapValues(main_point_adj_d, () => new Set<number>());
    const conn_comp_list: MStatusDelta[] = [];

    for (const [i, j] of conn_comp) {
        const idx = conn_comp_list.length;
        conn_comp_list.push(j);
        for (const k of i) {
            m2cc[k].add(idx);
        }
    }

    const keyed_std_form_entries = std_form.map((e) => [e[0], e] as const);
    const keyed_std_form = Object.fromEntries(keyed_std_form_entries);
    const keyed_std_form_set = new Set(keyed_std_form_entries);
    const keyed_std_form_range = range(keyed_std_form_set.size);

    const sorted_atom_key = Object.keys(keyed_std_form).toSorted();

    const tile_to_idx: Record<string, number> = {};
    for (const [i, j] of sorted_atom_key.entries()) {
        for (const k of keyed_std_form[j]) {
            tile_to_idx[k] = i;
        }
    }
    init_state.total_dam = 0;
    init_state["curse"] = -1;

    function add_delta(d1: MStatus, d2: MStatusDelta): MStatus;
    function add_delta(d1: MStatusDelta, d2: MStatusDelta): MStatusDelta;
    function add_delta(d1: MStatusDelta, d2: MStatusDelta): MStatusDelta {
        const d = { ...d1 };
        for (const [k, v] of Object.entries(d2)) {
            d[k] = (d[k] ?? 0) + v;
        }
        return d;
    }

    function ladd_delta(d1: MStatus, d2: MStatusDelta): MStatus;
    function ladd_delta(d1: MStatusDelta, d2: MStatusDelta): MStatusDelta;
    function ladd_delta(d1: MStatusDelta, d2: MStatusDelta): MStatusDelta {
        const d = d1;
        for (const [k, v] of Object.entries(d2)) {
            d[k] = (d[k] ?? 0) + v;
        }
        return d;
    }

    const supported_spec = new Set([0, 1, 2, 3, 4, 5, 6, 28]);
    const equip_effect = [
        [2, 0],
        [4, 0],
        [8, 0],
        [16, 0],
        [32, 0],
        [64, 0],
        [128, 0],
        [256, 0],
        [512, 0],
        [999, 99],
    ];
    const enemy_damage = (hero: MStatus, enemy: Enemy) => {
        let { hp: bhp, at: bat, df: bdf, mf: bmf } = hero;
        let { hp: mhp, at: mat, df: mdf, spec: mspec, point: mpoint } = enemy;
        if (hero.equip_level) {
            const [da, dd] = equip_effect[hero.equip_level - 1];
            bat += da;
            bdf += dd;
        }
        if (!Array.isArray(mspec)) {
            mspec = [mspec];
        }
        const mspecSet = new Set(mspec);
        for (const i of mspecSet.values()) {
            if (!supported_spec.has(i)) {
                throw new Error(`Unsupported special: ${i}`);
            }
        }
        // if (mspecSet.has(28)) {
        //     // double 20
        //     if 'double20' in self.flags) {
        //         bat *= 2
        if (bat <= mdf) {
            // cannot defeat
            return Math.max(999999, bhp * 4 + 4);
        }
        let bone = bat - mdf;
        let mone = Math.max(0, mat - bdf);
        if (mspecSet.has(2)) {
            // magic
            mone = mat;
        }
        if (mspecSet.has(3)) {
            // solid
            bone = Math.min(1, bone);
        }
        let count = Math.floor(Math.max(mhp - 1, 0) / bone);
        if (mspecSet.has(1)) {
            // speed
            count += 1;
        }
        if (mspecSet.has(4)) {
            // double
            count *= 2;
        }
        if (mspecSet.has(5)) {
            // triple
            count *= 3;
        }
        if (mspecSet.has(6)) {
            // xn
            count *= enemy["n"];
        }
        return Math.max(0, count * mone - bmf);
    };

    const dup_state = (state: MStatus) => ({ ...state });

    const apply_event = (state: MStatus, event: MEvent, coord) => {
        const [ty, obj] = event;
        switch (ty) {
            case "enemy": {
                const dam = enemy_damage(state, enemy_list[obj]);
                if (state["hp"] <= dam) {
                    return false;
                }
                state["hp"] -= dam;
                assert(dam >= heu1[coord], "heuristic function larger than actual");
                state.total_dam += dam - heu1[coord];
                return true;
            }
            case "door": {
                if (state[obj] >= 1) {
                    state[obj] -= 1;
                    return true;
                } else {
                    return false;
                }
            }
            case "delta": {
                ladd_delta(state, obj);
                return true;
            }
            default: {
                throw new Error(`unhandled: [${ty}, ${obj}]`);
            }
        }
    };

    const EMPTY_TUPLE = [void 0, void 0] as [undefined, undefined];
    const do_sequence = (state: MStatus, taken: Set<number>, l: string[], curse = -1) => {
        // only implemented topological curse, keying curse & hp curse may be implemented later - if we do not need hp, we avoid taking it
        const new_state = dup_state(state);
        if (new_state.curse !== -1) {
            // make out what it equals && see whether i sats
            const last = sorted_atom_key[new_state["curse"]];
            const last_l = keyed_std_form[last];
            if (last_l.every((i) => !(main_point_adj_d[i].includes(sorted_atom_key[curse])))) {
                // console.log('curse take effect');
                return EMPTY_TUPLE;
            }
        }
        new_state["curse"] = curse;
        const new_take = new Set<number>();
        let takes = false;
        for (const i of l) {
            if (!apply_event(new_state, main_point_desc[i], i)) {
                return EMPTY_TUPLE;
            }
            if (main_point_desc[i][0] === "delta") {
                takes = true;
            }
            for (const j of m2cc[i].keys()) {
                if (!taken.has(j) && !new_take.has(j)) {
                    new_take.add(j);
                    takes = true;
                    ladd_delta(new_state, conn_comp_list[j]);
                }
            }
        }
        if (takes) {
            new_state["curse"] = -1;
        } else {
            // console.log('cursed');
            // pass
        }
        return [new_state, new_take] as const;
    };

    const state_key = (state: MStatus) => state.hp;

    const get_feed_back = (feed_back: Record<number, number>, taken_set: Set<number>) => {
        return sum([...taken_set.keys()].map((e) => feed_back[e]));
    };

    const get_prior_target = (been_set: Set<number>, state: MStatus, avail: Set<string>, taken: Set<number>) => {
        const s = new Set<number>();
        for (const [i, j] of sorted_atom_key.entries()) {
            if (been_set.has(i)) {
                continue;
            }
            if (!avail.has(j)) {
                continue;
            }
            const delta = dup_state(state);

            const new_take = new Set<number>();
            const l = keyed_std_form[j];
            (() => {
                for (const k of l) {
                    const [ty, obj] = main_point_desc[k];
                    if (ty === "enemy") {
                        const dam = enemy_damage(state, enemy_list[obj]);
                        const expect = heu1[k];
                        assert(dam >= expect);
                        /**
                         * 
                            // consider the case where hp is too low
                            if (dam === expect) {
                                // cannot be reduced more
                                // pass
                            } else {
                                break
                            }
                         */
                        if (dam === 0) {
                            // pass
                        } else {
                            return;
                        }
                    } else if (ty === "door") {
                        if (delta[obj] >= 1) {
                            delta[obj] -= 1;
                        } else {
                            return;
                        }
                    } else if (ty === "delta") {
                        ladd_delta(delta, obj);
                    } else {
                        return;
                    }
                    for (const j of m2cc[k].keys()) {
                        if (!taken.has(j) && !new_take.has(j)) {
                            new_take.add(j);
                            ladd_delta(delta, conn_comp_list[j]);
                        }
                    }
                }
                if (Object.entries(delta).every(([k, v]) => v >= state[k])) {
                    s.add(i);
                }
            })();
        }
        return s;
    };

    interface PropagateConfig {
        feed_back?:  Record<number, number>;
        max_totaldam?: number;
    }
    const propagate = (search_state: SearchStateMap, choice_d, THRESHOLD = 262144, config: PropagateConfig = {}) => {
        const { feed_back, max_totaldam } = config;
        console.log("state space", search_state.size);
        let imprecise = false;
        if (search_state.size > THRESHOLD) {
            console.log("Trimming state");
            const key_f: (x: [SearchStateKey, SearchStateItem]) => number = feed_back
                ? ([k, v]) => v[0].total_dam - get_feed_back(feed_back, k)
                : ([k, v]) => v[0].total_dam;
            const state_list = sortBy([...search_state.entries()] as [SearchStateKey, SearchStateItem][], key_f);
            console.log("threshold dam:", key_f(state_list[THRESHOLD]));
            search_state = createSearchState(state_list.slice(0, THRESHOLD));
            imprecise = true;
        }
        const d: SearchStateMap = createSearchState();
        for (const [stateKey, [st, avail, taken, vroute]] of search_state.entries()) {
            const prior_target = get_prior_target(stateKey, st, avail, taken);
            let prior_been = false;
            for (const t of range(2)) {
                if (t === 1 && prior_been) {
                    break;
                }
                for (const [h, k] of sorted_atom_key.entries()) {
                    if (stateKey.has(h)) {
                        continue;
                    }
                    if (t !== 1 && !prior_target.has(h)) {
                        continue;
                    }
                    if (!avail.has(k)) {
                        continue;
                    }
                    // prune - prerequisite
                    if ([...prerequisite[h].keys()].some((e) => !stateKey.has(e))) {
                        continue;
                    }
                    // console.log(vroute,'->',k);
                    const l = keyed_std_form[k];
                    const [new_state, new_take] = do_sequence(st, taken, l, h);
                    //new_state, new_take = do_sequence(st, taken, l)
                    if (new_state === void 0) {
                        // console.log('die on',k);
                        continue;
                    }
                    if (t === 0) {
                        prior_been = true;
                    }
                    if (max_totaldam && new_state.total_dam > max_totaldam) {
                        // prune by overdamage
                        continue;
                    }
                    const key = new Set([...stateKey.keys(), h]);
                    if (d.has(key)) {
                        const [last_best_state, new_avail, new_taken] = d.get(key);
                        if (state_key(last_best_state) >= state_key(new_state)) {
                            continue;
                        }
                        d.set(key, [new_state, new_avail, new_taken, vroute.concat([h])]);
                    } else {
                        const new_taken = taken.union(new_take);
                        const new_avail = new Set(avail);
                        for (const m of l) {
                            main_point_adj_d[m].forEach((e) => new_avail.add(e));
                        }
                        d.set(key, [new_state, new_avail, new_taken, vroute.concat([h])]);
                    }
                }
            }
        }
        return [d, imprecise] as const;
    };

    // Astar algorithm
    // first we need to determine the highest power for each mob

    // algorithm weakness: cannot find the hidden truths - if both is unavailable, first can be harder to defeat

    const max_state_without_nodes = (s: Set<PositionString>) => {
        const fin_set = new Set<PositionString>();
        const been_set = new Set(init_avail_set);
        const q = [...init_avail_set.keys()];
        const bound_delta = {};
        while (q.length > 0) {
            const v = q.pop();
            if (s.has(v)) {
                continue;
            }
            fin_set.add(v);
            const [ty, obj] = main_point_desc[v];
            if (ty === "delta") {
                ladd_delta(bound_delta, obj);
            }
            const adj = main_point_adj_d[v];
            for (const j of adj) {
                if (!been_set.has(j)) {
                    been_set.add(j);
                    q.push(j);
                }
            }
        }
        const free_delta = conn_comp
            .filter(([k]) => !k.isDisjointFrom(fin_set))
            .map(([k, v]) => v)
            .reduce(add_delta, {});
        return [add_delta(add_delta(init_state, free_delta), bound_delta), fin_set] as const;
    };

    const damage_of_one_without_another = (c1: PositionString, c2?: PositionString) => {
        // c2 is any, c1 must be enemy
        // c2 must not block c1, assumed
        // all assumption!
        const [hero] = max_state_without_nodes(new Set([c1, c2]));
        //hero['hp'] = 999999
        const enemy = enemy_list[main_point_desc[c1][1] as number];
        return enemy_damage(hero, enemy);
    };

    const get_block_damage = (c: PositionString) => {
        const [, fin_set] = max_state_without_nodes(new Set([c]));
        return Object.entries(
            [...fin_set.keys()]
                .filter((e) => main_point_desc[e][0] === "enemy")
                .map((e) => damage_of_one_without_another(e, c))
        );
    };

    const get_unblock_damage = () => {
        return Object.fromEntries(
            Object.entries(main_point_desc)
                .filter(([k, v]) => v[0] === "enemy")
                .map(([k]) => [k, damage_of_one_without_another(k)])
        );
    };

    // then we determine the damage

    // LEVEL 1
    // v = {i: enemy_damage(max_state_without_node(
    //    i), enemy_list[j[1]]) if j[0] === 'enemy' else 0 for i, j in main_point_desc.items()}

    let heu1 = get_unblock_damage();
    console.log("x");

    // LEVEL 2

    const heu2 = Object.keys(main_point_adj_d).map((e) => get_block_damage(e));

    const damage_of_one_with_prerequisite = (c1: PositionString) => {
        // c2 is any, c1 must be enemy
        // c2 must not block c1, assumed
        // all assumption!
        const l = keyed_std_form[sorted_atom_key[tile_to_idx[c1]]];
        const without_set = new Set([
            ...[...inv_prerequisite[tile_to_idx[c1]].keys()].map((i) => keyed_std_form[sorted_atom_key[i]]).flat(1),
            ...l.slice(0, l.indexOf(c1)),
        ]);
        const [hero] = max_state_without_nodes(without_set);
        console.log("mob", c1, "best abil", hero);
        //hero['hp'] = 999999
        const enemy = enemy_list[main_point_desc[c1][1] as number];
        return enemy_damage(hero, enemy);
    };

    const update_max_damage = () => {
        return Object.fromEntries(
            [...Object.entries(main_point_desc)]
                .filter(([k, v]) => v[0] === "enemy")
                .map(([k]) => [k, damage_of_one_with_prerequisite(k)])
        );
    };

    const get_max_damage = (mon_c: PositionString, state_key: SearchStateKey) => {
        let v = heu1[mon_c];
        for (const [i, j] of heu2.entries()) {
            if (!state_key.has(i) && mon_c in j) {
                v = Math.max(v, j[mon_c]);
            }
        }
        return v;
    };

    // embed()

    const prerequisite = keyed_std_form_range.map(() => new Set<number>());

    const transpose = (sl: Set<number>[]) => {
        const l = range(sl.length).map((e) => new Set<number>());
        for (const [i, j] of sl.entries()) {
            for (const k of j.keys()) {
                l[k].add(i);
            }
        }
        return l;
    };

    interface ForceOrderConfig {
        THRESHOLD?: number;
        max_totaldam?: number;
    }
    const force_order = (config: ForceOrderConfig) => {
        const { THRESHOLD = 8192, max_totaldam } = config;
        let search_state: SearchStateMap = createSearchState([[new Set(), [init_state, init_avail_set, new Set(), []]]]);
        for (const i of keyed_std_form_range) {
            console.log("order hunting: Iteration", i + 1, "/", keyed_std_form_range.length);
            const [new_search_state, imprecise] = propagate(search_state, keyed_std_form, THRESHOLD, { max_totaldam });
            if (imprecise) {
                return commit_order(search_state);
            } else {
                search_state = new_search_state;
            }
        }
        console.log("This may make search too easy ... max is found");
        return;
    };

    const generate_possible_pair = (l: number[]) => {
        const ls = new Set(l);
        const s = new Set();
        for (const [i, j] of l.entries()) {
            for (const k of l.slice(i)) {
                s.add([k, j]);
            }
        }
        for (const i of l) {
            for (const j of keyed_std_form_range) {
                if (!ls.has(j)) {
                    s.add([i, j]);
                }
            }
        }
        return s;
    };

    /**
     * 
        For each two tile A,B
        a route may
        a) contain void 0
        b) contain both, A-B
        c) contain both, B-A
        d) contain A
        e) contain B
        b,d advocates that A<B
        c,e advocates that A>B
        a advocates that both may be true

        if a condition is not advocated, the contrary must be the truth && we can trim in later
    */
    const commit_order = (search_state: SearchStateMap) => {
        // const vec = keyed_std_form_range.map(e => Array(e).fill(0));
        let s = new Set(
            keyed_std_form_range
                .map((x) => keyed_std_form_range.filter((y) => x !== y).map((y) => [x, y] as const))
                .flat(1)
        );
        for (const v of search_state.values()) {
            s = s.intersection(generate_possible_pair(v[3]));
        }
        console.log(`we know ${s.size} constraints now`);
        //from IPython import embed;embed()
        for (const [i, j] of s.keys()) {
            prerequisite[j].add(i);
        }
    };

    let inv_prerequisite: Set<number>[] = [];
    console.log("pretrim");
    for (const i of [8192 /* 32768, 131072 */]) {
        force_order({ THRESHOLD: i });
        inv_prerequisite = transpose(prerequisite);
        heu1 = update_max_damage();
    }

    let max_totaldam: number;
    const feed_back: Record<number, number> = {};
    {
        let search_state: SearchStateMap = createSearchState([[new Set(), [init_state, init_avail_set, new Set(), []]]]);

        console.log("Weak search");

        for (const i of keyed_std_form_range) {
            console.log("Iteration", i + 1, "/", keyed_std_form_range.length);
            [search_state] = propagate(search_state, keyed_std_form, 8192);
            // console.log('state', search_state);
        }

        assert(search_state.size === 1);
        const [fin_state, , , vroute] = search_state.values().next().value as SearchStateItem;
        console.log("hp", fin_state["hp"]);
        console.log("total_dam", fin_state.total_dam);
        console.log("route", vroute);

        max_totaldam = fin_state.total_dam;

        // we avoid making the force_order to finish the search directly
        for (const threshold of [8192, 32768, 65536]) {
            console.log("=".repeat(60), "refine lower bound of damage, ITER", threshold);
            // update totaldam
            let st = dup_state(init_state);
            const taken = new Set<number>();

            for (const i of vroute) {
                const k = sorted_atom_key[i];
                const l = keyed_std_form[k];
                // console.log(i, l);
                const [new_state, new_take] = do_sequence(st, taken, l, i);
                assert(new_state);
                st = new_state;
                new_take.forEach((e) => taken.add(e));
            }
            console.log("total_dam", st.total_dam);
            // make trim
            force_order({ THRESHOLD: threshold, max_totaldam: st.total_dam });
            inv_prerequisite = transpose(prerequisite);
            heu1 = update_max_damage();
        }

        console.log("Strong search with feedback, prepare feedback");

        const dam_seq = [];
        {
            let st = dup_state(init_state);
            const taken = new Set<number>();

            for (const i of vroute) {
                const k = sorted_atom_key[i];
                const l = keyed_std_form[k];
                console.log(i, l);
                const [new_state, new_take] = do_sequence(st, taken, l, i);
                assert(new_state);
                feed_back[i] = new_state.total_dam - st.total_dam;
                dam_seq.push(new_state.total_dam);
                st = new_state;
                new_take.forEach((e) => taken.add(e));
            }
        }

        console.log("dam seq", dam_seq);
    }

    {
        console.log("Strong search ...");
        let search_state: SearchStateMap = createSearchState([[new Set(), [init_state, init_avail_set, new Set(), []]]]);

        for (const i of keyed_std_form_range) {
            console.log("Iteration", i + 1, "/", keyed_std_form_range.length);
            [search_state] = propagate(search_state, keyed_std_form, 262144, {
                feed_back,
                max_totaldam,
            });
            // console.log('state', search_state);
        }

        assert(search_state.size === 1);
        const [fin_state, , , vroute] = search_state.values().next().value as SearchStateItem;
        console.log("hp", fin_state["hp"]);
        console.log("route", vroute);
        fsp.writeFile(pathUtils.join(cwd, "ai_info.json"), vroute.map((i) => sorted_atom_key[i]).toString(), "utf-8");
    }
})();
