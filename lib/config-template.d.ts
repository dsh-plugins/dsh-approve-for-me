import { type ConfigField } from '@dsh-plugin/dsh-loader/config';
import type { ApproveForMeConfig } from './index.js';
export declare function createConfigTemplate(base: ApproveForMeConfig): {
    id: string;
    packageName: string;
    title: string;
    fields: {
        type: "group";
        label: string;
        fields: ConfigField[];
    }[];
};
